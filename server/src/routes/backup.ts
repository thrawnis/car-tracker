import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { verifyPassword } from "../auth/password.js";

// Deliberately dumb: the server never decrypts, re-encrypts, or otherwise
// touches the plaintext of any field here. It just relays whatever opaque
// ciphertext blobs the client already has (export) or has already prepared
// for this account's data key (import). All backup-file encryption -
// wrapping the vault key with a chosen passphrase, and re-encrypting fields
// when restoring under a different account's data key - happens entirely in
// the browser. See client/src/crypto/backup.ts.
export const backupRouter = Router();
backupRouter.use(requireAuth);

const ownershipStatuses = ["OWNED", "SOLD", "TOTALED", "TRADED_IN", "GIFTED"] as const;
const fuelUnits = ["GALLONS", "LITERS"] as const;
const triggerTypes = ["DATE_INTERVAL", "MILEAGE_INTERVAL", "DATE_OR_MILEAGE", "ONE_TIME_DATE"] as const;

backupRouter.get("/export-data", async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({
    where: { userId: req.userId! },
    include: { maintenanceRecords: true, fuelLogs: true, odometerReadings: true, reminderRules: true },
    orderBy: { createdAt: "asc" },
  });

  res.json({ vehicles });
});

const opaque = z.string().max(8000).nullable().optional();

const importSchema = z.object({
  password: z.string(),
  confirmReplace: z.literal(true),
  vehicles: z.array(
    z.object({
      year: z.number().int().nullable().optional(),
      make: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      trim: z.string().nullable().optional(),
      vinEncrypted: opaque,
      licensePlateEncrypted: opaque,
      nicknameEncrypted: opaque,
      notesEncrypted: opaque,
      ownershipStatus: z.enum(ownershipStatuses),
      acquiredDate: z.coerce.date().nullable().optional(),
      disposedDate: z.coerce.date().nullable().optional(),
      fuelUnit: z.enum(fuelUnits),
      photoUrl: z.string().nullable().optional(),
      maintenanceRecords: z.array(
        z.object({
          serviceType: z.string(),
          performedAt: z.coerce.date(),
          odometer: z.number().int().nullable().optional(),
          notesEncrypted: opaque,
          vendorEncrypted: opaque,
          costCentsEncrypted: opaque,
        }),
      ),
      fuelLogs: z.array(
        z.object({
          filledAt: z.coerce.date(),
          odometer: z.number().int(),
          quantity: z.number(),
          pricePerUnitCents: z.number().int().nullable().optional(),
          totalCostCents: z.number().int().nullable().optional(),
          missedFillUp: z.boolean().optional(),
          isFull: z.boolean().optional(),
          notesEncrypted: opaque,
        }),
      ),
      odometerReadings: z.array(
        z.object({ odometer: z.number().int(), readAt: z.coerce.date(), source: z.string() }),
      ),
      reminderRules: z.array(
        z.object({
          name: z.string(),
          triggerType: z.enum(triggerTypes),
          intervalDays: z.number().int().nullable().optional(),
          intervalMiles: z.number().int().nullable().optional(),
          oneTimeDate: z.coerce.date().nullable().optional(),
          lastCompletedAt: z.coerce.date().nullable().optional(),
          lastCompletedOdometer: z.number().int().nullable().optional(),
          leadDays: z.number().int(),
          leadMiles: z.number().int(),
          active: z.boolean(),
        }),
      ),
    }),
  ),
});

backupRouter.post("/import-data", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Restoring replaces this account's vehicle data entirely; login, 2FA,
    // and the vault itself are untouched.
    await tx.vehicle.deleteMany({ where: { userId: user.id } });

    for (const v of parsed.data.vehicles) {
      await tx.vehicle.create({
        data: {
          userId: user.id,
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
          maintenanceRecords: { create: v.maintenanceRecords },
          fuelLogs: { create: v.fuelLogs },
          odometerReadings: { create: v.odometerReadings },
          reminderRules: { create: v.reminderRules },
        },
      });
    }
  });

  res.status(204).end();
});
