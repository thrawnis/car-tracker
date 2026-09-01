/**
 * Fully client-side account backup. The server never sees plaintext, a
 * passphrase, or any key that could decrypt this data - see
 * server/src/routes/backup.ts, which just relays opaque blobs verbatim.
 */
import { api } from "@/api/client";
import type { ExportVehicle } from "@/api/types";
import {
  generateSaltB64,
  deriveKeyFromPassword,
  wrapKey,
  unwrapKey,
  keysAreEqual,
  decryptOptionalField,
  encryptOptionalField,
} from "./vault";

interface BackupFile {
  version: 1;
  exportedAt: string;
  vaultSalt: string;
  vaultKeyWrappedByPassphrase: string;
  vehicles: ExportVehicle[];
}

export async function exportBackup(dataKey: CryptoKey, passphrase: string): Promise<string> {
  const { vehicles } = await api.get<{ vehicles: ExportVehicle[] }>("/backup/export-data");

  const vaultSalt = generateSaltB64();
  const wrappingKey = await deriveKeyFromPassword(passphrase, vaultSalt);
  const vaultKeyWrappedByPassphrase = await wrapKey(dataKey, wrappingKey);

  const file: BackupFile = {
    version: 1,
    exportedAt: new Date().toISOString(),
    vaultSalt,
    vaultKeyWrappedByPassphrase,
    vehicles,
  };
  return JSON.stringify(file);
}

/** Decrypts the backup file's embedded data key with the given passphrase. Throws if wrong. */
export async function unlockBackupFile(
  fileContents: string,
  passphrase: string,
): Promise<{ backupDataKey: CryptoKey; vehicles: ExportVehicle[] }> {
  const file = JSON.parse(fileContents) as BackupFile;
  if (file.version !== 1) throw new Error("Unsupported backup file version");

  const wrappingKey = await deriveKeyFromPassword(passphrase, file.vaultSalt);
  const backupDataKey = await unwrapKey(file.vaultKeyWrappedByPassphrase, wrappingKey);
  return { backupDataKey, vehicles: file.vehicles };
}

/**
 * Re-keys every encrypted field in a backup's vehicle tree from `backupDataKey`
 * to `currentDataKey`, so it can be imported into (possibly) a different
 * account than the one it was exported from. If the keys are the same
 * (restoring into the same account), the ciphertext is already valid and is
 * passed through untouched.
 */
export async function reencryptForImport(
  vehicles: ExportVehicle[],
  backupDataKey: CryptoKey,
  currentDataKey: CryptoKey,
): Promise<ExportVehicle[]> {
  if (await keysAreEqual(backupDataKey, currentDataKey)) return vehicles;

  async function rekey(value: string | null): Promise<string | null> {
    const plaintext = await decryptOptionalField(value, backupDataKey);
    return encryptOptionalField(plaintext, currentDataKey);
  }

  return Promise.all(
    vehicles.map(async (v) => ({
      ...v,
      vinEncrypted: await rekey(v.vinEncrypted),
      licensePlateEncrypted: await rekey(v.licensePlateEncrypted),
      nicknameEncrypted: await rekey(v.nicknameEncrypted),
      notesEncrypted: await rekey(v.notesEncrypted),
      maintenanceRecords: await Promise.all(
        v.maintenanceRecords.map(async (m) => ({
          ...m,
          notesEncrypted: await rekey(m.notesEncrypted),
          vendorEncrypted: await rekey(m.vendorEncrypted),
          costCentsEncrypted: await rekey(m.costCentsEncrypted),
        })),
      ),
      fuelLogs: await Promise.all(
        v.fuelLogs.map(async (f) => ({ ...f, notesEncrypted: await rekey(f.notesEncrypted) })),
      ),
    })),
  );
}
