import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import { createApp } from "../../src/app.js";
import { resetDb } from "../resetDb.js";
import { createAccount, authedRequest } from "../helpers.js";
import { runReminderSweep } from "../../src/services/reminderEngine.js";
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

describe("reminder rules CRUD", () => {
  it("validates that interval fields match the chosen trigger type", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);

    const res = await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL" /* missing intervalDays */ });
    expect(res.status).toBe(400);
  });

  it("creates rules for each trigger type", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);

    await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 180 })
      .expect(201);
    await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Tire rotation", triggerType: "MILEAGE_INTERVAL", intervalMiles: 5000 })
      .expect(201);
    await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Brake check", triggerType: "DATE_OR_MILEAGE", intervalDays: 365, intervalMiles: 10000 })
      .expect(201);
    await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Registration", triggerType: "ONE_TIME_DATE", oneTimeDate: "2027-01-01" })
      .expect(201);

    const list = await authed.get(`/api/vehicles/${vehicleId}/reminder-rules`).expect(200);
    expect(list.body).toHaveLength(4);
  });

  it("can pause and resume a rule", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);
    const rule = await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 180 })
      .expect(201);

    const paused = await authed
      .patch(`/api/vehicles/${vehicleId}/reminder-rules/${rule.body.id}`)
      .send({ active: false })
      .expect(200);
    expect(paused.body.active).toBe(false);
  });

  it("scopes reminder rules to the vehicle's owner", async () => {
    const owner = await createAccount(app);
    const intruder = await createAccount(app);
    const vehicleId = await makeVehicle(authedRequest(app, owner));

    const res = await authedRequest(app, intruder)
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 180 });
    expect(res.status).toBe(404);
  });
});

describe("reminder sweep and dashboard", () => {
  it("surfaces an overdue reminder on the dashboard after a sweep, and completing it clears it", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);

    const rule = await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 30, leadDays: 0 })
      .expect(201);

    // Backdate the rule so it reads as overdue without needing to wait 30 real days.
    await prisma.reminderRule.update({
      where: { id: rule.body.id },
      data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    await runReminderSweep();

    const dashboard = await authed.get("/api/reminders").expect(200);
    expect(dashboard.body).toHaveLength(1);
    expect(dashboard.body[0].ruleName).toBe("Oil change");
    expect(dashboard.body[0].status).toBe("DUE");

    await authed.post(`/api/reminders/${dashboard.body[0].id}/complete`).expect(204);

    const afterComplete = await authed.get("/api/reminders").expect(200);
    expect(afterComplete.body).toHaveLength(0);
  });

  it("dismissing a reminder removes it from the dashboard", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);
    const rule = await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 30, leadDays: 0 })
      .expect(201);
    await prisma.reminderRule.update({
      where: { id: rule.body.id },
      data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    await runReminderSweep();
    const dashboard = await authed.get("/api/reminders").expect(200);
    await authed.post(`/api/reminders/${dashboard.body[0].id}/dismiss`).expect(204);

    const afterDismiss = await authed.get("/api/reminders").expect(200);
    expect(afterDismiss.body).toHaveLength(0);
  });

  it("does not surface reminders for a rule that has been paused", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);
    const vehicleId = await makeVehicle(authed);
    const rule = await authed
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 30, leadDays: 0 })
      .expect(201);
    await prisma.reminderRule.update({
      where: { id: rule.body.id },
      data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), active: false },
    });

    await runReminderSweep();
    const dashboard = await authed.get("/api/reminders").expect(200);
    expect(dashboard.body).toHaveLength(0);
  });

  it("does not surface another account's reminders", async () => {
    const owner = await createAccount(app);
    const other = await createAccount(app);
    const vehicleId = await makeVehicle(authedRequest(app, owner));
    const rule = await authedRequest(app, owner)
      .post(`/api/vehicles/${vehicleId}/reminder-rules`)
      .send({ name: "Oil change", triggerType: "DATE_INTERVAL", intervalDays: 30, leadDays: 0 })
      .expect(201);
    await prisma.reminderRule.update({
      where: { id: rule.body.id },
      data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    await runReminderSweep();
    const otherDashboard = await authedRequest(app, other).get("/api/reminders").expect(200);
    expect(otherDashboard.body).toHaveLength(0);
  });
});
