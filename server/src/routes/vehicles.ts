import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { loadOwnedVehicle } from "../lib/ownership.js";
import type { AccountCipher } from "../crypto/encryption.js";
import type { Vehicle } from "@prisma/client";

export const vehiclesRouter = Router();
vehiclesRouter.use(requireAuth);

function serializeVehicle(v: Vehicle, cipher: AccountCipher) {
  return {
    id: v.id,
    year: v.year,
    make: v.make,
    model: v.model,
    trim: v.trim,
    vin: cipher.decrypt(v.vinEncrypted),
    licensePlate: cipher.decrypt(v.licensePlateEncrypted),
    nickname: cipher.decrypt(v.nicknameEncrypted),
    notes: cipher.decrypt(v.notesEncrypted),
    ownershipStatus: v.ownershipStatus,
    acquiredDate: v.acquiredDate,
    disposedDate: v.disposedDate,
    fuelUnit: v.fuelUnit,
    photoUrl: v.photoUrl,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

const vehicleSchema = z.object({
  year: z.number().int().min(1900).max(2100).nullable().optional(),
  make: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  trim: z.string().max(100).nullable().optional(),
  vin: z.string().max(50).nullable().optional(),
  licensePlate: z.string().max(20).nullable().optional(),
  nickname: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
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
  res.json(vehicles.map((v) => serializeVehicle(v, req.cipher!)));
});

vehiclesRouter.post("/", async (req, res) => {
  const parsed = vehicleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const cipher = req.cipher!;
  const d = parsed.data;

  const vehicle = await prisma.vehicle.create({
    data: {
      userId: req.userId!,
      year: d.year ?? null,
      make: d.make ?? null,
      model: d.model ?? null,
      trim: d.trim ?? null,
      vinEncrypted: cipher.encrypt(d.vin),
      licensePlateEncrypted: cipher.encrypt(d.licensePlate),
      nicknameEncrypted: cipher.encrypt(d.nickname),
      notesEncrypted: cipher.encrypt(d.notes),
      ownershipStatus: d.ownershipStatus ?? "OWNED",
      acquiredDate: d.acquiredDate ?? null,
      disposedDate: d.disposedDate ?? null,
      fuelUnit: d.fuelUnit ?? "GALLONS",
      photoUrl: d.photoUrl ?? null,
    },
  });

  res.status(201).json(serializeVehicle(vehicle, cipher));
});

vehiclesRouter.get("/:id", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, req.params.id);
  if (!vehicle) return;
  res.json(serializeVehicle(vehicle, req.cipher!));
});

vehiclesRouter.patch("/:id", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, req.params.id);
  if (!vehicle) return;

  const parsed = vehicleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const cipher = req.cipher!;
  const d = parsed.data;

  const updated = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: {
      ...(d.year !== undefined ? { year: d.year } : {}),
      ...(d.make !== undefined ? { make: d.make } : {}),
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(d.trim !== undefined ? { trim: d.trim } : {}),
      ...(d.vin !== undefined ? { vinEncrypted: cipher.encrypt(d.vin) } : {}),
      ...(d.licensePlate !== undefined ? { licensePlateEncrypted: cipher.encrypt(d.licensePlate) } : {}),
      ...(d.nickname !== undefined ? { nicknameEncrypted: cipher.encrypt(d.nickname) } : {}),
      ...(d.notes !== undefined ? { notesEncrypted: cipher.encrypt(d.notes) } : {}),
      ...(d.ownershipStatus !== undefined ? { ownershipStatus: d.ownershipStatus } : {}),
      ...(d.acquiredDate !== undefined ? { acquiredDate: d.acquiredDate } : {}),
      ...(d.disposedDate !== undefined ? { disposedDate: d.disposedDate } : {}),
      ...(d.fuelUnit !== undefined ? { fuelUnit: d.fuelUnit } : {}),
      ...(d.photoUrl !== undefined ? { photoUrl: d.photoUrl } : {}),
    },
  });

  res.json(serializeVehicle(updated, cipher));
});

vehiclesRouter.delete("/:id", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, req.params.id);
  if (!vehicle) return;
  await prisma.vehicle.delete({ where: { id: vehicle.id } });
  res.status(204).end();
});
