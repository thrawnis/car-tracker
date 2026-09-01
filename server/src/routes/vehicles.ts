import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { loadOwnedVehicle } from "../lib/ownership.js";
import type { Vehicle } from "@prisma/client";

export const vehiclesRouter = Router();
vehiclesRouter.use(requireAuth);

// The server never decrypts these fields - it just stores and returns whatever
// opaque ciphertext blob the client sent (see client/src/crypto/vault.ts).
// It has no key that could produce or verify plaintext for them.
function serializeVehicle(v: Vehicle) {
  return {
    id: v.id,
    year: v.year,
    make: v.make,
    model: v.model,
    trim: v.trim,
    vinEncrypted: v.vinEncrypted,
    licensePlateEncrypted: v.licensePlateEncrypted,
    nicknameEncrypted: v.nicknameEncrypted,
    notesEncrypted: v.notesEncrypted,
    ownershipStatus: v.ownershipStatus,
    acquiredDate: v.acquiredDate,
    disposedDate: v.disposedDate,
    fuelUnit: v.fuelUnit,
    photoUrl: v.photoUrl,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

const opaque = z.string().max(8000).nullable().optional();

const vehicleSchema = z.object({
  year: z.number().int().min(1900).max(2100).nullable().optional(),
  make: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  trim: z.string().max(100).nullable().optional(),
  vinEncrypted: opaque,
  licensePlateEncrypted: opaque,
  nicknameEncrypted: opaque,
  notesEncrypted: opaque,
  ownershipStatus: z.enum(["OWNED", "SOLD", "TOTALED", "TRADED_IN", "GIFTED"]).optional(),
  acquiredDate: z.coerce.date().nullable().optional(),
  disposedDate: z.coerce.date().nullable().optional(),
  fuelUnit: z.enum(["GALLONS", "LITERS"]).optional(),
  photoUrl: z.string().url().max(2000).nullable().optional(),
});

vehiclesRouter.get("/", async (req, res) => {
  const status = req.query.status as string | undefined;
  const vehicles = await prisma.vehicle.findMany({
    where: {
      userId: req.userId!,
      ...(status === "current" ? { ownershipStatus: "OWNED" } : {}),
      ...(status === "past" ? { ownershipStatus: { not: "OWNED" } } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(vehicles.map(serializeVehicle));
});

vehiclesRouter.post("/", async (req, res) => {
  const parsed = vehicleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;

  const vehicle = await prisma.vehicle.create({
    data: {
      userId: req.userId!,
      year: d.year ?? null,
      make: d.make ?? null,
      model: d.model ?? null,
      trim: d.trim ?? null,
      vinEncrypted: d.vinEncrypted ?? null,
      licensePlateEncrypted: d.licensePlateEncrypted ?? null,
      nicknameEncrypted: d.nicknameEncrypted ?? null,
      notesEncrypted: d.notesEncrypted ?? null,
      ownershipStatus: d.ownershipStatus ?? "OWNED",
      acquiredDate: d.acquiredDate ?? null,
      disposedDate: d.disposedDate ?? null,
      fuelUnit: d.fuelUnit ?? "GALLONS",
      photoUrl: d.photoUrl ?? null,
    },
  });

  res.status(201).json(serializeVehicle(vehicle));
});

vehiclesRouter.get("/:id", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, req.params.id);
  if (!vehicle) return;
  res.json(serializeVehicle(vehicle));
});

vehiclesRouter.patch("/:id", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, req.params.id);
  if (!vehicle) return;

  const parsed = vehicleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;

  const updated = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: {
      ...(d.year !== undefined ? { year: d.year } : {}),
      ...(d.make !== undefined ? { make: d.make } : {}),
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(d.trim !== undefined ? { trim: d.trim } : {}),
      ...(d.vinEncrypted !== undefined ? { vinEncrypted: d.vinEncrypted } : {}),
      ...(d.licensePlateEncrypted !== undefined ? { licensePlateEncrypted: d.licensePlateEncrypted } : {}),
      ...(d.nicknameEncrypted !== undefined ? { nicknameEncrypted: d.nicknameEncrypted } : {}),
      ...(d.notesEncrypted !== undefined ? { notesEncrypted: d.notesEncrypted } : {}),
      ...(d.ownershipStatus !== undefined ? { ownershipStatus: d.ownershipStatus } : {}),
      ...(d.acquiredDate !== undefined ? { acquiredDate: d.acquiredDate } : {}),
      ...(d.disposedDate !== undefined ? { disposedDate: d.disposedDate } : {}),
      ...(d.fuelUnit !== undefined ? { fuelUnit: d.fuelUnit } : {}),
      ...(d.photoUrl !== undefined ? { photoUrl: d.photoUrl } : {}),
    },
  });

  res.json(serializeVehicle(updated));
});

vehiclesRouter.delete("/:id", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, req.params.id);
  if (!vehicle) return;
  await prisma.vehicle.delete({ where: { id: vehicle.id } });
  res.status(204).end();
});
