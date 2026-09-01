import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import { createApp } from "../../src/app.js";
import { resetDb } from "../resetDb.js";
import { createAccount, authedRequest, encryptField, decryptField } from "../helpers.js";
import {
  generateSaltB64,
  deriveKeyFromPassword,
  wrapKey,
  unwrapKey,
  generateDataKey,
} from "../../../client/src/crypto/vault.js";

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDb();
});

async function seedVehicle(authed: ReturnType<typeof authedRequest>, dataKey: CryptoKey) {
  const vinEncrypted = await encryptField("1HGCM82633A004352", dataKey);
  const notesEncrypted = await encryptField("garage kept", dataKey);
  const vehicle = await authed
    .post("/api/vehicles")
    .send({ year: 2020, make: "Honda", model: "Civic", vinEncrypted, notesEncrypted })
    .expect(201);

  const vendorEncrypted = await encryptField("Jiffy Lube", dataKey);
  const costCentsEncrypted = await encryptField("4500", dataKey);
  await authed
    .post(`/api/vehicles/${vehicle.body.id}/maintenance`)
    .send({ serviceType: "Oil Change", performedAt: "2026-01-01", odometer: 10000, vendorEncrypted, costCentsEncrypted })
    .expect(201);
  await authed
    .post(`/api/vehicles/${vehicle.body.id}/fuel`)
    .send({ filledAt: "2026-01-01", odometer: 10000, quantity: 12, totalCostCents: 4000 })
    .expect(201);
  await authed
    .post(`/api/vehicles/${vehicle.body.id}/reminder-rules`)
    .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 180 })
    .expect(201);
  return vehicle.body.id as string;
}

/** Simulates the client's exportBackup(): fetch the raw tree, wrap the data key with a passphrase. */
async function clientExport(authed: ReturnType<typeof authedRequest>, dataKey: CryptoKey, passphrase: string) {
  const res = await authed.get("/api/backup/export-data").expect(200);
  const vaultSalt = generateSaltB64();
  const vaultKeyWrappedByPassphrase = await wrapKey(dataKey, await deriveKeyFromPassword(passphrase, vaultSalt));
  return { vaultSalt, vaultKeyWrappedByPassphrase, vehicles: res.body.vehicles };
}

describe("account export (dumb passthrough)", () => {
  it("returns the vehicle tree with sensitive fields still encrypted, untouched", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await seedVehicle(authed, account.dataKey);

    const res = await authed.get("/api/backup/export-data").expect(200);
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain("1HGCM82633A004352");
    expect(bodyText).not.toContain("garage kept");
    expect(bodyText).not.toContain("Jiffy Lube");

    const [vehicle] = res.body.vehicles;
    expect(await decryptField(vehicle.vinEncrypted, account.dataKey)).toBe("1HGCM82633A004352");
    expect(vehicle.maintenanceRecords).toHaveLength(1);
    expect(vehicle.fuelLogs).toHaveLength(1);
    expect(vehicle.reminderRules).toHaveLength(1);
  });

  it("scopes export to the requesting account", async () => {
    const owner = await createAccount(app);
    const other = await createAccount(app);
    await seedVehicle(authedRequest(app, owner), owner.dataKey);

    const res = await authedRequest(app, other).get("/api/backup/export-data").expect(200);
    expect(res.body.vehicles).toHaveLength(0);
  });
});

describe("account import (dumb passthrough)", () => {
  it("rejects import with the wrong account password", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const res = await authed
      .post("/api/backup/import-data")
      .send({ password: "wrong", confirmReplace: true, vehicles: [] });
    expect(res.status).toBe(401);
  });

  it("round-trips a full export back through import into the same account unchanged", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await seedVehicle(authed, account.dataKey);

    const exported = await clientExport(authed, account.dataKey, "backup passphrase 123");

    await authed.delete(`/api/vehicles/${(await authed.get("/api/vehicles")).body[0].id}`).expect(204);
    expect((await authed.get("/api/vehicles")).body).toHaveLength(0);

    // Same account, same data key: the ciphertext is already valid, no re-encryption needed.
    await authed
      .post("/api/backup/import-data")
      .send({ password: account.password, confirmReplace: true, vehicles: exported.vehicles })
      .expect(204);

    const vehicles = await authed.get("/api/vehicles").expect(200);
    expect(vehicles.body).toHaveLength(1);
    expect(await decryptField(vehicles.body[0].vinEncrypted, account.dataKey)).toBe("1HGCM82633A004352");

    const maintenance = await authed.get(`/api/vehicles/${vehicles.body[0].id}/maintenance`).expect(200);
    expect(maintenance.body).toHaveLength(1);
    expect(await decryptField(maintenance.body[0].vendorEncrypted, account.dataKey)).toBe("Jiffy Lube");

    const fuel = await authed.get(`/api/vehicles/${vehicles.body[0].id}/fuel`).expect(200);
    expect(fuel.body).toHaveLength(1);

    const rules = await authed.get(`/api/vehicles/${vehicles.body[0].id}/reminder-rules`).expect(200);
    expect(rules.body).toHaveLength(1);
  });

  it("replaces existing vehicles rather than merging", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await seedVehicle(authed, account.dataKey);
    const exported = await clientExport(authed, account.dataKey, "pw");

    await authed.post("/api/vehicles").send({ make: "Toyota", model: "Corolla" }).expect(201);
    expect((await authed.get("/api/vehicles")).body).toHaveLength(2);

    await authed
      .post("/api/backup/import-data")
      .send({ password: account.password, confirmReplace: true, vehicles: exported.vehicles })
      .expect(204);

    const vehicles = await authed.get("/api/vehicles").expect(200);
    expect(vehicles.body).toHaveLength(1);
    expect(vehicles.body[0].make).toBe("Honda");
  });

  it("supports restoring into a different account by re-encrypting fields client-side first", async () => {
    // This simulates what the client's reencryptForImport() does: decrypt with
    // the backup's data key, re-encrypt with the importing account's data key.
    // The server is never involved in, or aware of, this re-keying.
    const exporter = await createAccount(app);
    const importer = await createAccount(app);
    await seedVehicle(authedRequest(app, exporter), exporter.dataKey);

    const exportRes = await authedRequest(app, exporter).get("/api/backup/export-data").expect(200);
    const [vehicle] = exportRes.body.vehicles;

    const rekey = async (value: string | null) => {
      const plaintext = await decryptField(value, exporter.dataKey);
      return encryptField(plaintext, importer.dataKey);
    };

    const reencrypted = [
      {
        ...vehicle,
        vinEncrypted: await rekey(vehicle.vinEncrypted),
        notesEncrypted: await rekey(vehicle.notesEncrypted),
        maintenanceRecords: await Promise.all(
          vehicle.maintenanceRecords.map(async (m: { vendorEncrypted: string; costCentsEncrypted: string }) => ({
            ...m,
            vendorEncrypted: await rekey(m.vendorEncrypted),
            costCentsEncrypted: await rekey(m.costCentsEncrypted),
          })),
        ),
      },
    ];

    await authedRequest(app, importer)
      .post("/api/backup/import-data")
      .send({ password: importer.password, confirmReplace: true, vehicles: reencrypted })
      .expect(204);

    const vehicles = await authedRequest(app, importer).get("/api/vehicles").expect(200);
    expect(await decryptField(vehicles.body[0].vinEncrypted, importer.dataKey)).toBe("1HGCM82633A004352");
    // The exporter's key must NOT decrypt what's now stored for the importer.
    expect(await decryptField(vehicles.body[0].vinEncrypted, exporter.dataKey)).toBeNull();
  });

  it("rejects import payloads that don't confirmReplace", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const res = await authed.post("/api/backup/import-data").send({ password: account.password, vehicles: [] });
    expect(res.status).toBe(400);
  });
});

describe("unlockBackupFile-equivalent passphrase wrapping", () => {
  it("only unwraps with the correct passphrase (exercised against the wrap primitives directly)", async () => {
    const dataKey = await generateDataKey();
    const vaultSalt = generateSaltB64();
    const wrapped = await wrapKey(dataKey, await deriveKeyFromPassword("right passphrase", vaultSalt));

    const rightKey = await deriveKeyFromPassword("right passphrase", vaultSalt);
    await expect(unwrapKey(wrapped, rightKey)).resolves.toBeTruthy();

    const wrongKey = await deriveKeyFromPassword("wrong passphrase", vaultSalt);
    await expect(unwrapKey(wrapped, wrongKey)).rejects.toThrow();
  });
});
