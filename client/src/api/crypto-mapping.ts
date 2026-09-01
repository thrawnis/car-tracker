import { decryptOptionalField, encryptOptionalField, decryptInt, encryptInt } from "@/crypto/vault";
import type { RawVehicle, RawMaintenanceRecord, RawFuelLog, Vehicle, MaintenanceRecord, FuelLog } from "./types";

export async function decryptVehicle(v: RawVehicle, dataKey: CryptoKey): Promise<Vehicle> {
  const [vin, licensePlate, nickname, notes] = await Promise.all([
    decryptOptionalField(v.vinEncrypted, dataKey),
    decryptOptionalField(v.licensePlateEncrypted, dataKey),
    decryptOptionalField(v.nicknameEncrypted, dataKey),
    decryptOptionalField(v.notesEncrypted, dataKey),
  ]);
  return {
    id: v.id,
    year: v.year,
    make: v.make,
    model: v.model,
    trim: v.trim,
    vin,
    licensePlate,
    nickname,
    notes,
    ownershipStatus: v.ownershipStatus,
    acquiredDate: v.acquiredDate,
    disposedDate: v.disposedDate,
    fuelUnit: v.fuelUnit,
    photoUrl: v.photoUrl,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export interface VehicleInput {
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  vin?: string | null;
  licensePlate?: string | null;
  nickname?: string | null;
  notes?: string | null;
  ownershipStatus?: Vehicle["ownershipStatus"];
  acquiredDate?: string | null;
  disposedDate?: string | null;
  fuelUnit?: Vehicle["fuelUnit"];
  photoUrl?: string | null;
}

export async function encryptVehicleInput(input: VehicleInput, dataKey: CryptoKey) {
  const [vinEncrypted, licensePlateEncrypted, nicknameEncrypted, notesEncrypted] = await Promise.all([
    "vin" in input ? encryptOptionalField(input.vin, dataKey) : undefined,
    "licensePlate" in input ? encryptOptionalField(input.licensePlate, dataKey) : undefined,
    "nickname" in input ? encryptOptionalField(input.nickname, dataKey) : undefined,
    "notes" in input ? encryptOptionalField(input.notes, dataKey) : undefined,
  ]);
  return {
    ...("year" in input ? { year: input.year } : {}),
    ...("make" in input ? { make: input.make } : {}),
    ...("model" in input ? { model: input.model } : {}),
    ...("trim" in input ? { trim: input.trim } : {}),
    ...("vin" in input ? { vinEncrypted } : {}),
    ...("licensePlate" in input ? { licensePlateEncrypted } : {}),
    ...("nickname" in input ? { nicknameEncrypted } : {}),
    ...("notes" in input ? { notesEncrypted } : {}),
    ...("ownershipStatus" in input ? { ownershipStatus: input.ownershipStatus } : {}),
    ...("acquiredDate" in input ? { acquiredDate: input.acquiredDate } : {}),
    ...("disposedDate" in input ? { disposedDate: input.disposedDate } : {}),
    ...("fuelUnit" in input ? { fuelUnit: input.fuelUnit } : {}),
    ...("photoUrl" in input ? { photoUrl: input.photoUrl } : {}),
  };
}

export async function decryptMaintenanceRecord(m: RawMaintenanceRecord, dataKey: CryptoKey): Promise<MaintenanceRecord> {
  const [notes, vendor, costCents] = await Promise.all([
    decryptOptionalField(m.notesEncrypted, dataKey),
    decryptOptionalField(m.vendorEncrypted, dataKey),
    decryptInt(m.costCentsEncrypted, dataKey),
  ]);
  return {
    id: m.id,
    vehicleId: m.vehicleId,
    serviceType: m.serviceType,
    performedAt: m.performedAt,
    odometer: m.odometer,
    notes,
    vendor,
    costCents,
    reminderRuleId: m.reminderRuleId,
    createdAt: m.createdAt,
  };
}

export interface MaintenanceInput {
  serviceType: string;
  performedAt: string;
  odometer?: number | null;
  notes?: string | null;
  vendor?: string | null;
  costCents?: number | null;
  reminderRuleId?: string | null;
}

export async function encryptMaintenanceInput(input: MaintenanceInput, dataKey: CryptoKey) {
  const [notesEncrypted, vendorEncrypted, costCentsEncrypted] = await Promise.all([
    encryptOptionalField(input.notes, dataKey),
    encryptOptionalField(input.vendor, dataKey),
    encryptInt(input.costCents, dataKey),
  ]);
  return {
    serviceType: input.serviceType,
    performedAt: input.performedAt,
    odometer: input.odometer ?? null,
    notesEncrypted,
    vendorEncrypted,
    costCentsEncrypted,
    reminderRuleId: input.reminderRuleId ?? null,
  };
}

export async function decryptFuelLog(f: RawFuelLog, dataKey: CryptoKey): Promise<FuelLog> {
  const notes = await decryptOptionalField(f.notesEncrypted, dataKey);
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
    notes,
    economy: f.economy,
    createdAt: f.createdAt,
  };
}

export interface FuelInput {
  filledAt: string;
  odometer: number;
  quantity: number;
  totalCostCents?: number | null;
  isFull?: boolean;
  missedFillUp?: boolean;
  notes?: string | null;
}

export async function encryptFuelInput(input: FuelInput, dataKey: CryptoKey) {
  const notesEncrypted = await encryptOptionalField(input.notes, dataKey);
  return {
    filledAt: input.filledAt,
    odometer: input.odometer,
    quantity: input.quantity,
    totalCostCents: input.totalCostCents ?? null,
    isFull: input.isFull,
    missedFillUp: input.missedFillUp,
    notesEncrypted,
  };
}
