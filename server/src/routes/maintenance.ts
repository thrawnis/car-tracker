import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { loadOwnedVehicle, vehicleIdParam } from "../lib/ownership.js";
import type { MaintenanceRecord } from "@prisma/client";
import { recordOdometerReading } from "../lib/odometer.js";

export const maintenanceRouter = Router({ mergeParams: true });
maintenanceRouter.use(requireAuth);

// Opaque ciphertext pass-through - see vehicles.ts for why.
function serialize(m: MaintenanceRecord) {
  return {
    id: m.id,
    vehicleId: m.vehicleId,
    serviceType: m.serviceType,
    performedAt: m.performedAt,
    odometer: m.odometer,
    notesEncrypted: m.notesEncrypted,
    vendorEncrypted: m.vendorEncrypted,
    costCentsEncrypted: m.costCentsEncrypted,
    reminderRuleId: m.reminderRuleId,
    createdAt: m.createdAt,
  };
}

const opaque = z.string().max(8000).nullable().optional();

const schema = z.object({
  serviceType: z.string().min(1).max(200),
  performedAt: z.coerce.date(),
  odometer: z.number().int().nonnegative().nullable().optional(),
  notesEncrypted: opaque,
  vendorEncrypted: opaque,
  costCentsEncrypted: opaque,
  reminderRuleId: z.string().uuid().nullable().optional(),
});

maintenanceRouter.get("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const records = await prisma.maintenanceRecord.findMany({
    where: { vehicleId: vehicle.id },
    orderBy: { performedAt: "desc" },
  });
  res.json(records.map(serialize));
});

maintenanceRouter.post("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;

  const record = await prisma.maintenanceRecord.create({
    data: {
      vehicleId: vehicle.id,
      serviceType: d.serviceType,
      performedAt: d.performedAt,
      odometer: d.odometer ?? null,
      notesEncrypted: d.notesEncrypted ?? null,
      vendorEncrypted: d.vendorEncrypted ?? null,
      costCentsEncrypted: d.costCentsEncrypted ?? null,
      reminderRuleId: d.reminderRuleId ?? null,
    },
  });

  if (d.reminderRuleId) {
    await prisma.reminderRule.update({
      where: { id: d.reminderRuleId },
      data: { lastCompletedAt: d.performedAt, lastCompletedOdometer: d.odometer ?? undefined },
    });
  }

  if (d.odometer != null) {
    await recordOdometerReading(vehicle.id, d.odometer, d.performedAt, "maintenance");
  }

  res.status(201).json(serialize(record));
});

async function loadOwnedRecord(req: import("express").Request, res: import("express").Response, id: string) {
  const record = await prisma.maintenanceRecord.findFirst({
    where: { id, vehicle: { userId: req.userId! } },
  });
  if (!record) {
    res.status(404).json({ error: "Maintenance record not found" });
    return null;
  }
  return record;
}

maintenanceRouter.patch("/:id", async (req, res) => {
  const record = await loadOwnedRecord(req, res, req.params.id);
  if (!record) return;

  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;

  const updated = await prisma.maintenanceRecord.update({
    where: { id: record.id },
    data: {
      ...(d.serviceType !== undefined ? { serviceType: d.serviceType } : {}),
      ...(d.performedAt !== undefined ? { performedAt: d.performedAt } : {}),
      ...(d.odometer !== undefined ? { odometer: d.odometer } : {}),
      ...(d.notesEncrypted !== undefined ? { notesEncrypted: d.notesEncrypted } : {}),
      ...(d.vendorEncrypted !== undefined ? { vendorEncrypted: d.vendorEncrypted } : {}),
      ...(d.costCentsEncrypted !== undefined ? { costCentsEncrypted: d.costCentsEncrypted } : {}),
      ...(d.reminderRuleId !== undefined ? { reminderRuleId: d.reminderRuleId } : {}),
    },
  });

  res.json(serialize(updated));
});

maintenanceRouter.delete("/:id", async (req, res) => {
  const record = await loadOwnedRecord(req, res, req.params.id);
  if (!record) return;
  await prisma.maintenanceRecord.delete({ where: { id: record.id } });
  res.status(204).end();
});
