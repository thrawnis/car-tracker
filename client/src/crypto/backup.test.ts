import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateDataKey, encryptOptionalField, decryptOptionalField } from "./vault";
import { unlockBackupFile, reencryptForImport, exportBackup } from "./backup";
import type { ExportVehicle } from "@/api/types";

vi.mock("@/api/client", () => ({
  api: { get: vi.fn() },
}));

function emptyVehicle(overrides: Partial<ExportVehicle> = {}): ExportVehicle {
  return {
    year: 2020,
    make: "Honda",
    model: "Civic",
    trim: null,
    vinEncrypted: null,
    licensePlateEncrypted: null,
    nicknameEncrypted: null,
    notesEncrypted: null,
    ownershipStatus: "OWNED",
    acquiredDate: null,
    disposedDate: null,
    fuelUnit: "GALLONS",
    photoUrl: null,
    maintenanceRecords: [],
    fuelLogs: [],
    odometerReadings: [],
    reminderRules: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("exportBackup / unlockBackupFile", () => {
  it("round-trips: the file's embedded key unwraps with the right passphrase", async () => {
    const { api } = await import("@/api/client");
    const dataKey = await generateDataKey();
    vi.mocked(api.get).mockResolvedValue({ vehicles: [emptyVehicle({ make: "Toyota" })] });

    const file = await exportBackup(dataKey, "correct horse battery staple");
    const { backupDataKey, vehicles } = await unlockBackupFile(file, "correct horse battery staple");

    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]!.make).toBe("Toyota");
    // Confirm it's really the same key: something encrypted with the original
    // dataKey should decrypt fine with the unwrapped backupDataKey.
    const encrypted = await encryptOptionalField("secret vin", dataKey);
    expect(await decryptOptionalField(encrypted, backupDataKey)).toBe("secret vin");
  });

  it("fails to unwrap with the wrong passphrase", async () => {
    const { api } = await import("@/api/client");
    const dataKey = await generateDataKey();
    vi.mocked(api.get).mockResolvedValue({ vehicles: [] });

    const file = await exportBackup(dataKey, "right passphrase");
    await expect(unlockBackupFile(file, "wrong passphrase")).rejects.toThrow();
  });

  it("rejects an unsupported file version", async () => {
    const { api } = await import("@/api/client");
    const dataKey = await generateDataKey();
    vi.mocked(api.get).mockResolvedValue({ vehicles: [] });

    const file = JSON.parse(await exportBackup(dataKey, "pw"));
    const tampered = JSON.stringify({ ...file, version: 99 });
    await expect(unlockBackupFile(tampered, "pw")).rejects.toThrow(/version/i);
  });
});

describe("reencryptForImport", () => {
  it("passes ciphertext through untouched when importing into the same account", async () => {
    const dataKey = await generateDataKey();
    const vinEncrypted = await encryptOptionalField("1HGCM82633A004352", dataKey);
    const vehicles = [emptyVehicle({ vinEncrypted })];

    const result = await reencryptForImport(vehicles, dataKey, dataKey);
    expect(result[0]!.vinEncrypted).toBe(vinEncrypted);
  });

  it("re-encrypts vehicle and nested maintenance/fuel fields for a different account key", async () => {
    const backupKey = await generateDataKey();
    const currentKey = await generateDataKey();

    const vehicles = [
      emptyVehicle({
        vinEncrypted: await encryptOptionalField("1HGCM82633A004352", backupKey),
        notesEncrypted: await encryptOptionalField("garage kept", backupKey),
        maintenanceRecords: [
          {
            serviceType: "Oil Change",
            performedAt: "2026-01-01",
            odometer: 10000,
            notesEncrypted: await encryptOptionalField("synthetic", backupKey),
            vendorEncrypted: await encryptOptionalField("Jiffy Lube", backupKey),
            costCentsEncrypted: await encryptOptionalField("4500", backupKey),
          },
        ],
        fuelLogs: [
          {
            filledAt: "2026-01-01",
            odometer: 10000,
            quantity: 12,
            pricePerUnitCents: null,
            totalCostCents: 4000,
            missedFillUp: false,
            isFull: true,
            notesEncrypted: await encryptOptionalField("premium", backupKey),
          },
        ],
      }),
    ];

    const result = await reencryptForImport(vehicles, backupKey, currentKey);

    // Old key can no longer decrypt (returns null rather than throwing); new key can.
    expect(await decryptOptionalField(result[0]!.vinEncrypted, backupKey)).toBeNull();
    expect(await decryptOptionalField(result[0]!.vinEncrypted, currentKey)).toBe("1HGCM82633A004352");
    expect(await decryptOptionalField(result[0]!.notesEncrypted, currentKey)).toBe("garage kept");
    expect(await decryptOptionalField(result[0]!.maintenanceRecords[0]!.vendorEncrypted, currentKey)).toBe(
      "Jiffy Lube",
    );
    expect(await decryptOptionalField(result[0]!.fuelLogs[0]!.notesEncrypted, currentKey)).toBe("premium");
  });
});
