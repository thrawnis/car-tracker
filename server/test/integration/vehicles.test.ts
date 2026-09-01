import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import request from "supertest";
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

describe("vehicle CRUD", () => {
  it("stores sensitive fields as opaque ciphertext, verbatim - the server never touches them", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);

    const vinEncrypted = await encryptField("1HGCM82633A004352", account.dataKey);
    const notesEncrypted = await encryptField("test notes", account.dataKey);

    const res = await authed
      .post("/api/vehicles")
      .send({ year: 2020, make: "Honda", model: "Civic", vinEncrypted, notesEncrypted })
      .expect(201);

    // Pure pass-through: the response's ciphertext is byte-for-byte what we sent.
    expect(res.body.vinEncrypted).toBe(vinEncrypted);
    expect(res.body.notesEncrypted).toBe(notesEncrypted);
    expect(await decryptField(res.body.vinEncrypted, account.dataKey)).toBe("1HGCM82633A004352");

    const row = await prisma.vehicle.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.vinEncrypted).toBe(vinEncrypted);
    expect(row.vinEncrypted).not.toContain("1HGCM82633A004352");
    expect(row.notesEncrypted).not.toContain("test notes");
  });

  it("a different account's data key cannot decrypt another account's fields", async () => {
    const owner = await createAccount(app);
    const other = await createAccount(app);
    const vinEncrypted = await encryptField("1HGCM82633A004352", owner.dataKey);

    const res = await authedRequest(app, owner).post("/api/vehicles").send({ make: "Honda", vinEncrypted }).expect(201);

    expect(await decryptField(res.body.vinEncrypted, other.dataKey)).toBeNull();
    expect(await decryptField(res.body.vinEncrypted, owner.dataKey)).toBe("1HGCM82633A004352");
  });

  it("lists only the requesting account's vehicles", async () => {
    const accountA = await createAccount(app);
    const accountB = await createAccount(app);
    await authedRequest(app, accountA).post("/api/vehicles").send({ make: "Honda" }).expect(201);
    await authedRequest(app, accountB).post("/api/vehicles").send({ make: "Toyota" }).expect(201);

    const listA = await authedRequest(app, accountA).get("/api/vehicles").expect(200);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].make).toBe("Honda");
  });

  it("filters by ownership status", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    await authed.post("/api/vehicles").send({ make: "Current", ownershipStatus: "OWNED" }).expect(201);
    await authed.post("/api/vehicles").send({ make: "Old", ownershipStatus: "SOLD" }).expect(201);

    const current = await authed.get("/api/vehicles?status=current").expect(200);
    expect(current.body.map((v: { make: string }) => v.make)).toEqual(["Current"]);

    const past = await authed.get("/api/vehicles?status=past").expect(200);
    expect(past.body.map((v: { make: string }) => v.make)).toEqual(["Old"]);
  });

  it("404s (not leaks) when fetching another account's vehicle", async () => {
    const accountA = await createAccount(app);
    const accountB = await createAccount(app);
    const created = await authedRequest(app, accountA).post("/api/vehicles").send({ make: "Honda" }).expect(201);

    const res = await authedRequest(app, accountB).get(`/api/vehicles/${created.body.id}`);
    expect(res.status).toBe(404);
  });

  it("404s when patching or deleting another account's vehicle", async () => {
    const accountA = await createAccount(app);
    const accountB = await createAccount(app);
    const created = await authedRequest(app, accountA).post("/api/vehicles").send({ make: "Honda" }).expect(201);

    await authedRequest(app, accountB).patch(`/api/vehicles/${created.body.id}`).send({ make: "Hacked" }).expect(404);
    await authedRequest(app, accountB).delete(`/api/vehicles/${created.body.id}`).expect(404);

    const stillThere = await authedRequest(app, accountA).get(`/api/vehicles/${created.body.id}`).expect(200);
    expect(stillThere.body.make).toBe("Honda");
  });

  it("updates fields via PATCH, including re-encrypting sensitive fields", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const oldVinEncrypted = await encryptField("OLDVIN", account.dataKey);
    const created = await authed.post("/api/vehicles").send({ make: "Honda", vinEncrypted: oldVinEncrypted }).expect(201);

    const newVinEncrypted = await encryptField("NEWVIN123", account.dataKey);
    const updated = await authed
      .patch(`/api/vehicles/${created.body.id}`)
      .send({ vinEncrypted: newVinEncrypted, ownershipStatus: "SOLD" })
      .expect(200);

    expect(await decryptField(updated.body.vinEncrypted, account.dataKey)).toBe("NEWVIN123");
    expect(updated.body.ownershipStatus).toBe("SOLD");
    expect(updated.body.make).toBe("Honda");
  });

  it("deletes a vehicle", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const created = await authed.post("/api/vehicles").send({ make: "Honda" }).expect(201);

    await authed.delete(`/api/vehicles/${created.body.id}`).expect(204);
    await authed.get(`/api/vehicles/${created.body.id}`).expect(404);
  });

  it("rejects requests without authentication", async () => {
    const res = await request(app).get("/api/vehicles");
    expect(res.status).toBe(401);
  });
});
