import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { loadOwnedVehicle, vehicleIdParam } from "../lib/ownership.js";
import { recordOdometerReading } from "../lib/odometer.js";
import type { AccountCipher } from "../crypto/encryption.js";
import type { FuelLog } from "@prisma/client";

export const fuelRouter = Router({ mergeParams: true });
fuelRouter.use(requireAuth);

function serialize(f: FuelLog, cipher: AccountCipher) {
  return {
    id: f.id,
    vehicleId: f.vehicleId,
    filledAt: f.filledAt,
    odometer: f.odometer,
    quantity: f.quantity,
    pricePerUnitCents: f.pricePerUnitCents,
    totalCostCents: f.totalCostCents,
    missedFillUp: f.missedFillUp,
    isFull: f.isFull,
    notes: cipher.decrypt(f.notesEncrypted),
    createdAt: f.createdAt,
  };
}

const schema = z.object({
  filledAt: z.coerce.date(),
  odometer: z.number().int().nonnegative(),
  quantity: z.number().positive(),
  pricePerUnitCents: z.number().int().nonnegative().nullable().optional(),
  totalCostCents: z.number().int().nonnegative().nullable().optional(),
  missedFillUp: z.boolean().optional(),
  isFull: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

/**
 * Computes fuel economy between consecutive *full* fill-ups. A `missedFillUp` entry means
 * the driver knows a previous fill-up went unlogged, so any window ending there can't be
 * trusted: it publishes no economy figure and, if it was itself a full fill-up, becomes the
 * fresh starting anchor for the next window (since we do know the tank was topped off then).
 */
function computeEconomy(logs: FuelLog[], fuelUnit: "GALLONS" | "LITERS") {
  const sorted = [...logs].sort((a, b) => a.odometer - b.odometer);
  const results: { fuelLogId: string; distance: number; economy: number | null }[] = [];

  let sinceLastFull: FuelLog[] = [];
  for (const log of sorted) {
    sinceLastFull.push(log);

    if (log.missedFillUp) {
      // The window ending here is unreliable regardless of isFull; no economy is published.
      sinceLastFull = log.isFull ? [log] : [];
      continue;
    }

    if (log.isFull) {
      const first = sinceLastFull[0]!;
      const distance = log.odometer - first.odometer;
      // Fuel used is everything added strictly after the starting (previous full) fill-up.
      const quantityUsed = sinceLastFull.slice(1).reduce((sum, l) => sum + l.quantity, 0);
      const economy =
        distance > 0 && quantityUsed > 0
          ? fuelUnit === "GALLONS"
            ? distance / quantityUsed // MPG
            : (quantityUsed / distance) * 100 // L/100km
          : null;
      results.push({ fuelLogId: log.id, distance, economy });
      sinceLastFull = [log];
    }
  }

  return results;
}

fuelRouter.get("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const logs = await prisma.fuelLog.findMany({
    where: { vehicleId: vehicle.id },
    orderBy: { filledAt: "desc" },
  });

  const economyByLogId = new Map(computeEconomy(logs, vehicle.fuelUnit).map((r) => [r.fuelLogId, r]));

  res.json(
    logs.map((l) => ({
      ...serialize(l, req.cipher!),
      economy: economyByLogId.get(l.id)?.economy ?? null,
    })),
  );
});

fuelRouter.post("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const cipher = req.cipher!;
  const d = parsed.data;

  const log = await prisma.fuelLog.create({
    data: {
      vehicleId: vehicle.id,
      filledAt: d.filledAt,
      odometer: d.odometer,
      quantity: d.quantity,
      pricePerUnitCents: d.pricePerUnitCents ?? null,
      totalCostCents: d.totalCostCents ?? null,
      missedFillUp: d.missedFillUp ?? false,
      isFull: d.isFull ?? true,
      notesEncrypted: cipher.encrypt(d.notes),
    },
  });

  await recordOdometerReading(vehicle.id, d.odometer, d.filledAt, "fuel_log");

  res.status(201).json(serialize(log, cipher));
});

async function loadOwnedLog(req: import("express").Request, res: import("express").Response, id: string) {
  const log = await prisma.fuelLog.findFirst({ where: { id, vehicle: { userId: req.userId! } } });
  if (!log) {
    res.status(404).json({ error: "Fuel log not found" });
    return null;
  }
  return log;
}

fuelRouter.patch("/:id", async (req, res) => {
  const log = await loadOwnedLog(req, res, req.params.id);
  if (!log) return;

  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const cipher = req.cipher!;
  const d = parsed.data;

  const updated = await prisma.fuelLog.update({
    where: { id: log.id },
    data: {
      ...(d.filledAt !== undefined ? { filledAt: d.filledAt } : {}),
      ...(d.odometer !== undefined ? { odometer: d.odometer } : {}),
      ...(d.quantity !== undefined ? { quantity: d.quantity } : {}),
      ...(d.pricePerUnitCents !== undefined ? { pricePerUnitCents: d.pricePerUnitCents } : {}),
      ...(d.totalCostCents !== undefined ? { totalCostCents: d.totalCostCents } : {}),
      ...(d.missedFillUp !== undefined ? { missedFillUp: d.missedFillUp } : {}),
      ...(d.isFull !== undefined ? { isFull: d.isFull } : {}),
      ...(d.notes !== undefined ? { notesEncrypted: cipher.encrypt(d.notes) } : {}),
    },
  });

  res.json(serialize(updated, cipher));
});

fuelRouter.delete("/:id", async (req, res) => {
  const log = await loadOwnedLog(req, res, req.params.id);
  if (!log) return;
  await prisma.fuelLog.delete({ where: { id: log.id } });
  res.status(204).end();
});
