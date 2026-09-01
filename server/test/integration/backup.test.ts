import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import { createApp } from "../../src/app.js";
import { resetDb } from "../resetDb.js";
import { createAccount, authedRequest } from "../helpers.js";

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDb();
});

async function seedVehicle(authed: ReturnType<typeof authedRequest>) {
  const vehicle = await authed
    .post("/api/vehicles")
    .send({ year: 2020, make: "Honda", model: "Civic", vin: "1HGCM82633A004352", notes: "garage kept" })
    .expect(201);
  await authed
    .post(`/api/vehicles/${vehicle.body.id}/maintenance`)
    .send({ serviceType: "Oil Change", performedAt: "2026-01-01", odometer: 10000, vendor: "Jiffy Lube", costCents: 4500 })
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

describe("account export", () => {
  it("rejects export with the wrong account password", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const res = await authed.post("/api/backup/export").send({ password: "wrong", passphrase: "backuppass123" });
    expect(res.status).toBe(401);
  });

  it("exports an encrypted file that does not contain plaintext sensitive data", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await seedVehicle(authed);

    const res = await authed
      .post("/api/backup/export")
      .send({ password: account.password, passphrase: "backuppass123" })
      .expect(200);

    const fileContents = res.text;
    expect(fileContents).not.toContain("1HGCM82633A004352");
    expect(fileContents).not.toContain("garage kept");
    expect(fileContents).not.toContain("Jiffy Lube");
    expect(() => JSON.parse(fileContents)).not.toThrow();
    const envelope = JSON.parse(fileContents);
    expect(envelope.v).toBe(1);
  });
});

describe("account import (restore)", () => {
  it("round-trips a full export back through import into the same account", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await seedVehicle(authed);

    const exportRes = await authed
      .post("/api/backup/export")
      .send({ password: account.password, passphrase: "backuppass123" })
      .expect(200);

    await authed.delete(`/api/vehicles/${(await authed.get("/api/vehicles")).body[0].id}`).expect(204);
    expect((await authed.get("/api/vehicles")).body).toHaveLength(0);

    await authed
      .post("/api/backup/import")
      .send({
        password: account.password,
        passphrase: "backuppass123",
        fileContents: exportRes.text,
        confirmReplace: true,
      })
      .expect(204);

    const vehicles = await authed.get("/api/vehicles").expect(200);
    expect(vehicles.body).toHaveLength(1);
    expect(vehicles.body[0].vin).toBe("1HGCM82633A004352");
    expect(vehicles.body[0].notes).toBe("garage kept");

    const maintenance = await authed.get(`/api/vehicles/${vehicles.body[0].id}/maintenance`).expect(200);
    expect(maintenance.body).toHaveLength(1);
    expect(maintenance.body[0].vendor).toBe("Jiffy Lube");
    expect(maintenance.body[0].costCents).toBe(4500);

    const fuel = await authed.get(`/api/vehicles/${vehicles.body[0].id}/fuel`).expect(200);
    expect(fuel.body).toHaveLength(1);

    const rules = await authed.get(`/api/vehicles/${vehicles.body[0].id}/reminder-rules`).expect(200);
    expect(rules.body).toHaveLength(1);
  });

  it("replaces existing vehicles rather than merging", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await seedVehicle(authed);
    const exportRes = await authed
      .post("/api/backup/export")
      .send({ password: account.password, passphrase: "pw-but-long-enough" })
      .expect(200);

    // Add a second, different vehicle after the export was taken.
    await authed.post("/api/vehicles").send({ make: "Toyota", model: "Corolla" }).expect(201);
    expect((await authed.get("/api/vehicles")).body).toHaveLength(2);

    await authed
      .post("/api/backup/import")
      .send({ password: account.password, passphrase: "pw-but-long-enough", fileContents: exportRes.text, confirmReplace: true })
      .expect(204);

    const vehicles = await authed.get("/api/vehicles").expect(200);
    expect(vehicles.body).toHaveLength(1);
    expect(vehicles.body[0].make).toBe("Honda");
  });

  it("rejects import with the wrong passphrase", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await seedVehicle(authed);
    const exportRes = await authed
      .post("/api/backup/export")
      .send({ password: account.password, passphrase: "correct-passphrase" })
      .expect(200);

    const res = await authed.post("/api/backup/import").send({
      password: account.password,
      passphrase: "wrong-passphrase",
      fileContents: exportRes.text,
      confirmReplace: true,
    });
    expect(res.status).toBe(400);
  });

  it("checks the requester's own password, not the exporting account's", async () => {
    const accountA = await createAccount(app, "accountApassword123");
    const accountB = await createAccount(app, "accountBpassword456");
    await seedVehicle(authedRequest(app, accountA));
    const exportRes = await authedRequest(app, accountA)
      .post("/api/backup/export")
      .send({ password: accountA.password, passphrase: "pw-but-long-enough" })
      .expect(200);

    // accountB is authenticated as itself, so import checks *its* password, not
    // accountA's — supplying accountA's password here must be rejected.
    const res = await authedRequest(app, accountB)
      .post("/api/backup/import")
      .send({ password: accountA.password, passphrase: "pw-but-long-enough", fileContents: exportRes.text, confirmReplace: true });
    expect(res.status).toBe(401);
  });
});
