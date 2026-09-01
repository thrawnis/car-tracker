import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { verifyPassword } from "../auth/password.js";
import { encryptExportPayload, decryptExportPayload } from "../crypto/encryption.js";

export const backupRouter = Router();
backupRouter.use(requireAuth);

interface ExportedVehicle {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  vin: string | null;
  licensePlate: string | null;
  nickname: string | null;
  notes: string | null;
  ownershipStatus: string;
  acquiredDate: string | null;
  disposedDate: string | null;
  fuelUnit: string;
  photoUrl: string | null;
  maintenanceRecords: {
    serviceType: string;
    performedAt: string;
    odometer: number | null;
    notes: string | null;
    vendor: string | null;
    costCents: number | null;
  }[];
  fuelLogs: {
    filledAt: string;
    odometer: number;
    quantity: number;
    pricePerUnitCents: number | null;
    totalCostCents: number | null;
    missedFillUp: boolean;
    isFull: boolean;
    notes: string | null;
  }[];
  odometerReadings: { odometer: number; readAt: string; source: string }[];
  reminderRules: {
    name: string;
    triggerType: string;
    intervalDays: number | null;
    intervalMiles: number | null;
    oneTimeDate: string | null;
    lastCompletedAt: string | null;
    lastCompletedOdometer: number | null;
    leadDays: number;
    leadMiles: number;
    active: boolean;
  }[];
}

interface ExportFormat {
  version: 1;
  exportedAt: string;
  account: { email: string; timezone: string; reminderEmail: string | null; reminderLeadDays: number };
  vehicles: ExportedVehicle[];
}

const exportSchema = z.object({ password: z.string(), passphrase: z.string().min(8) });

backupRouter.post("/export", async (req, res) => {
  const parsed = exportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "password and a passphrase (min 8 chars) for the backup file are required" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }

  const cipher = req.cipher!;
  const vehicles = await prisma.vehicle.findMany({
    where: { userId: user.id },
    include: { maintenanceRecords: true, fuelLogs: true, odometerReadings: true, reminderRules: true },
  });

  const payload: ExportFormat = {
    version: 1,
    exportedAt: new Date().toISOString(),
    account: {
      email: user.email,
      timezone: user.timezone,
      reminderEmail: user.reminderEmail,
      reminderLeadDays: user.reminderLeadDays,
    },
    vehicles: vehicles.map((v) => ({
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      vin: cipher.decrypt(v.vinEncrypted),
      licensePlate: cipher.decrypt(v.licensePlateEncrypted),
      nickname: cipher.decrypt(v.nicknameEncrypted),
      notes: cipher.decrypt(v.notesEncrypted),
      ownershipStatus: v.ownershipStatus,
      acquiredDate: v.acquiredDate?.toISOString() ?? null,
      disposedDate: v.disposedDate?.toISOString() ?? null,
      fuelUnit: v.fuelUnit,
      photoUrl: v.photoUrl,
      maintenanceRecords: v.maintenanceRecords.map((m) => ({
        serviceType: m.serviceType,
        performedAt: m.performedAt.toISOString(),
        odometer: m.odometer,
        notes: cipher.decrypt(m.notesEncrypted),
        vendor: cipher.decrypt(m.vendorEncrypted),
        costCents: cipher.decryptInt(m.costCentsEncrypted),
      })),
      fuelLogs: v.fuelLogs.map((f) => ({
        filledAt: f.filledAt.toISOString(),
        odometer: f.odometer,
        quantity: f.quantity,
        pricePerUnitCents: f.pricePerUnitCents,
        totalCostCents: f.totalCostCents,
        missedFillUp: f.missedFillUp,
        isFull: f.isFull,
        notes: cipher.decrypt(f.notesEncrypted),
      })),
      odometerReadings: v.odometerReadings.map((o) => ({
        odometer: o.odometer,
        readAt: o.readAt.toISOString(),
        source: o.source,
      })),
      reminderRules: v.reminderRules.map((r) => ({
        name: r.name,
        triggerType: r.triggerType,
        intervalDays: r.intervalDays,
        intervalMiles: r.intervalMiles,
        oneTimeDate: r.oneTimeDate?.toISOString() ?? null,
        lastCompletedAt: r.lastCompletedAt?.toISOString() ?? null,
        lastCompletedOdometer: r.lastCompletedOdometer,
        leadDays: r.leadDays,
        leadMiles: r.leadMiles,
        active: r.active,
      })),
    })),
  };

  const file = encryptExportPayload(payload, parsed.data.passphrase);

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="car-tracker-backup-${Date.now()}.ctbackup"`);
  res.send(file);
});

const importSchema = z.object({
  password: z.string(),
  passphrase: z.string(),
  fileContents: z.string(),
  confirmReplace: z.literal(true),
});

backupRouter.post("/import", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "password, passphrase, fileContents, and confirmReplace: true are required",
    });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }

  let payload: ExportFormat;
  try {
    payload = decryptExportPayload<ExportFormat>(parsed.data.fileContents, parsed.data.passphrase);
  } catch {
    res.status(400).json({ error: "Could not decrypt backup file: wrong passphrase or corrupted file" });
    return;
  }

  if (payload.version !== 1) {
    res.status(400).json({ error: "Unsupported backup file version" });
    return;
  }

  const cipher = req.cipher!;

  await prisma.$transaction(async (tx) => {
    // Restoring replaces this account's vehicle data entirely; the account
    // itself (login, 2FA, encryption key) is untouched.
    await tx.vehicle.deleteMany({ where: { userId: user.id } });

    for (const v of payload.vehicles) {
      await tx.vehicle.create({
        data: {
          userId: user.id,
          year: v.year,
          make: v.make,
          model: v.model,
          trim: v.trim,
          vinEncrypted: cipher.encrypt(v.vin),
          licensePlateEncrypted: cipher.encrypt(v.licensePlate),
          nicknameEncrypted: cipher.encrypt(v.nickname),
          notesEncrypted: cipher.encrypt(v.notes),
          ownershipStatus: v.ownershipStatus as never,
          acquiredDate: v.acquiredDate ? new Date(v.acquiredDate) : null,
          disposedDate: v.disposedDate ? new Date(v.disposedDate) : null,
          fuelUnit: v.fuelUnit as never,
          photoUrl: v.photoUrl,
          maintenanceRecords: {
            create: v.maintenanceRecords.map((m) => ({
              serviceType: m.serviceType,
              performedAt: new Date(m.performedAt),
              odometer: m.odometer,
              notesEncrypted: cipher.encrypt(m.notes),
              vendorEncrypted: cipher.encrypt(m.vendor),
              costCentsEncrypted: cipher.encryptInt(m.costCents),
            })),
          },
          fuelLogs: {
            create: v.fuelLogs.map((f) => ({
              filledAt: new Date(f.filledAt),
              odometer: f.odometer,
              quantity: f.quantity,
              pricePerUnitCents: f.pricePerUnitCents,
              totalCostCents: f.totalCostCents,
              missedFillUp: f.missedFillUp,
              isFull: f.isFull,
              notesEncrypted: cipher.encrypt(f.notes),
            })),
          },
          odometerReadings: {
            create: v.odometerReadings.map((o) => ({
              odometer: o.odometer,
              readAt: new Date(o.readAt),
              source: o.source,
            })),
          },
          reminderRules: {
            create: v.reminderRules.map((r) => ({
              name: r.name,
              triggerType: r.triggerType as never,
              intervalDays: r.intervalDays,
              intervalMiles: r.intervalMiles,
              oneTimeDate: r.oneTimeDate ? new Date(r.oneTimeDate) : null,
              lastCompletedAt: r.lastCompletedAt ? new Date(r.lastCompletedAt) : null,
              lastCompletedOdometer: r.lastCompletedOdometer,
              leadDays: r.leadDays,
              leadMiles: r.leadMiles,
              active: r.active,
            })),
          },
        },
      });
    }

    await tx.user.update({
      where: { id: user.id },
      data: {
        timezone: payload.account.timezone,
        reminderEmail: payload.account.reminderEmail,
        reminderLeadDays: payload.account.reminderLeadDays,
      },
    });
  });

  res.status(204).end();
});
