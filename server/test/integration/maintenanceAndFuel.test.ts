import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import { createApp } from "../../src/app.js";
import { resetDb } from "../resetDb.js";
import { createAccount, authedRequest, encryptField, decryptField } from "../helpers.js";
import { prisma } from "../../src/lib/db.js";

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDb();
});

async function makeVehicle(authed: ReturnType<typeof authedRequest>) {
  const res = await authed.post("/api/vehicles").send({ make: "Honda", model: "Civic" }).expect(201);
  return res.body.id as string;
}

describe("maintenance records", () => {
  it("logs a maintenance record with encrypted vendor/notes/cost, and records an odometer reading", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);

    const vendorEncrypted = await encryptField("Jiffy Lube", account.dataKey);
    const costCentsEncrypted = await encryptField("4500", account.dataKey);
    const notesEncrypted = await encryptField("synthetic oil", account.dataKey);

    const res = await authed
      .post(`/api/vehicles/${vehicleId}/maintenance`)
      .send({
        serviceType: "Oil Change",
        performedAt: "2026-01-01",
        odometer: 10000,
        vendorEncrypted,
        costCentsEncrypted,
        notesEncrypted,
      })
      .expect(201);

    expect(await decryptField(res.body.vendorEncrypted, account.dataKey)).toBe("Jiffy Lube");
    expect(await decryptField(res.body.costCentsEncrypted, account.dataKey)).toBe("4500");
    expect(await decryptField(res.body.notesEncrypted, account.dataKey)).toBe("synthetic oil");

    // The server just relays what it was given - it never sees "4500" itself.
    const row = await prisma.maintenanceRecord.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.costCentsEncrypted).toBe(costCentsEncrypted);

    const odometer = await authed.get(`/api/vehicles/${vehicleId}/odometer`).expect(200);
    expect(odometer.body[0].odometer).toBe(10000);
    expect(odometer.body[0].source).toBe("maintenance");
  });

  it("scopes maintenance access to the vehicle's owner", async () => {
    const owner = await createAccount(app);
    const intruder = await createAccount(app);
    const vehicleId = await makeVehicle(authedRequest(app, owner));
    const record = await authedRequest(app, owner)
      .post(`/api/vehicles/${vehicleId}/maintenance`)
      .send({ serviceType: "Oil Change", performedAt: "2026-01-01" })
      .expect(201);

    await authedRequest(app, intruder).get(`/api/vehicles/${vehicleId}/maintenance`).expect(404);
    await authedRequest(app, intruder)
      .patch(`/api/vehicles/${vehicleId}/maintenance/${record.body.id}`)
      .send({ serviceType: "Hacked" })
      .expect(404);
  });

  it("lists maintenance most-recent first", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);
    await authed.post(`/api/vehicles/${vehicleId}/maintenance`).send({ serviceType: "A", performedAt: "2026-01-01" });
    await authed.post(`/api/vehicles/${vehicleId}/maintenance`).send({ serviceType: "B", performedAt: "2026-06-01" });

    const list = await authed.get(`/api/vehicles/${vehicleId}/maintenance`).expect(200);
    expect(list.body.map((r: { serviceType: string }) => r.serviceType)).toEqual(["B", "A"]);
  });

  it("deletes a maintenance record", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);
    const record = await authed
      .post(`/api/vehicles/${vehicleId}/maintenance`)
      .send({ serviceType: "Oil Change", performedAt: "2026-01-01" })
      .expect(201);

    await authed.delete(`/api/vehicles/${vehicleId}/maintenance/${record.body.id}`).expect(204);
    const list = await authed.get(`/api/vehicles/${vehicleId}/maintenance`).expect(200);
    expect(list.body).toHaveLength(0);
  });
});

describe("fuel logs and economy calculation", () => {
  it("computes MPG between consecutive full fill-ups", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);

    await authed
      .post(`/api/vehicles/${vehicleId}/fuel`)
      .send({ filledAt: "2026-01-01", odometer: 10000, quantity: 12, isFull: true })
      .expect(201);
    await authed
      .post(`/api/vehicles/${vehicleId}/fuel`)
      .send({ filledAt: "2026-01-10", odometer: 10300, quantity: 10, isFull: true })
      .expect(201);

    const list = await authed.get(`/api/vehicles/${vehicleId}/fuel`).expect(200);
    const bySeq = [...list.body].sort((a, b) => a.odometer - b.odometer);
    expect(bySeq[0].economy).toBeNull(); // no prior full fill-up to measure against
    expect(bySeq[1].economy).toBeCloseTo(30); // 300 miles / 10 gallons
  });

  it("does not compute economy across a missed fill-up", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);

    await authed
      .post(`/api/vehicles/${vehicleId}/fuel`)
      .send({ filledAt: "2026-01-01", odometer: 10000, quantity: 12, isFull: true })
      .expect(201);
    await authed
      .post(`/api/vehicles/${vehicleId}/fuel`)
      .send({ filledAt: "2026-01-05", odometer: 10150, quantity: 6, isFull: true, missedFillUp: true })
      .expect(201);
    await authed
      .post(`/api/vehicles/${vehicleId}/fuel`)
      .send({ filledAt: "2026-01-10", odometer: 10300, quantity: 10, isFull: true })
      .expect(201);

    const list = await authed.get(`/api/vehicles/${vehicleId}/fuel`).expect(200);
    const bySeq = [...list.body].sort((a, b) => a.odometer - b.odometer);
    // The missed fill-up breaks the interval: economy resets after it instead of
    // silently including unaccounted-for fuel from before it was logged.
    expect(bySeq[2].economy).toBeCloseTo(150 / 10);
  });

  it("records an odometer reading from a fuel log", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);

    await authed
      .post(`/api/vehicles/${vehicleId}/fuel`)
      .send({ filledAt: "2026-01-01", odometer: 12345, quantity: 10 })
      .expect(201);

    const odometer = await authed.get(`/api/vehicles/${vehicleId}/odometer`).expect(200);
    expect(odometer.body[0].odometer).toBe(12345);
    expect(odometer.body[0].source).toBe("fuel_log");
  });
});
