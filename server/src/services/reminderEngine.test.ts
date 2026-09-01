import { describe, it, expect } from "vitest";
import type { ReminderRule } from "@prisma/client";
import { evaluateRule } from "./reminderEngine.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRule(overrides: Partial<ReminderRule>): ReminderRule {
  return {
    id: "rule-1",
    vehicleId: "vehicle-1",
    name: "Oil change",
    triggerType: "DATE_INTERVAL",
    intervalDays: null,
    intervalMiles: null,
    oneTimeDate: null,
    lastCompletedAt: null,
    lastCompletedOdometer: null,
    leadDays: 7,
    leadMiles: 300,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("evaluateRule: DATE_INTERVAL", () => {
  it("is not due when well before the interval + lead window", () => {
    const rule = makeRule({ triggerType: "DATE_INTERVAL", intervalDays: 180, leadDays: 7 });
    const now = new Date(rule.createdAt.getTime() + 10 * DAY_MS);
    expect(evaluateRule(rule, null, now).isDue).toBe(false);
  });

  it("becomes due once inside the lead window before the due date", () => {
    const rule = makeRule({ triggerType: "DATE_INTERVAL", intervalDays: 180, leadDays: 7 });
    const dueDate = rule.createdAt.getTime() + 180 * DAY_MS;
    const now = new Date(dueDate - 6 * DAY_MS); // 6 days out, inside a 7-day lead window
    expect(evaluateRule(rule, null, now).isDue).toBe(true);
  });

  it("stays due after the due date has passed (overdue)", () => {
    const rule = makeRule({ triggerType: "DATE_INTERVAL", intervalDays: 30, leadDays: 0 });
    const now = new Date(rule.createdAt.getTime() + 60 * DAY_MS);
    const result = evaluateRule(rule, null, now);
    expect(result.isDue).toBe(true);
    expect(result.dueDate).toEqual(new Date(rule.createdAt.getTime() + 30 * DAY_MS));
  });

  it("bases the next due date on lastCompletedAt, not createdAt, once serviced", () => {
    const lastCompletedAt = new Date("2026-06-01T00:00:00Z");
    const rule = makeRule({ triggerType: "DATE_INTERVAL", intervalDays: 30, leadDays: 0, lastCompletedAt });
    const justAfterService = new Date(lastCompletedAt.getTime() + DAY_MS);
    expect(evaluateRule(rule, null, justAfterService).isDue).toBe(false);
  });
});

describe("evaluateRule: MILEAGE_INTERVAL", () => {
  it("is not due when current odometer is well under the threshold", () => {
    const rule = makeRule({ triggerType: "MILEAGE_INTERVAL", intervalMiles: 5000, leadMiles: 300 });
    expect(evaluateRule(rule, 1000).isDue).toBe(false);
  });

  it("becomes due once inside the lead-mile window", () => {
    const rule = makeRule({ triggerType: "MILEAGE_INTERVAL", intervalMiles: 5000, leadMiles: 300 });
    expect(evaluateRule(rule, 4750).isDue).toBe(true);
  });

  it("is never due if there is no odometer reading yet", () => {
    const rule = makeRule({ triggerType: "MILEAGE_INTERVAL", intervalMiles: 5000, leadMiles: 300 });
    expect(evaluateRule(rule, null).isDue).toBe(false);
  });

  it("bases the next threshold on lastCompletedOdometer once serviced", () => {
    const rule = makeRule({
      triggerType: "MILEAGE_INTERVAL",
      intervalMiles: 5000,
      leadMiles: 300,
      lastCompletedOdometer: 20000,
    });
    expect(evaluateRule(rule, 24000).isDue).toBe(false);
    expect(evaluateRule(rule, 24750).isDue).toBe(true);
  });
});

describe("evaluateRule: DATE_OR_MILEAGE", () => {
  it("is due when only the date leg has triggered", () => {
    const rule = makeRule({
      triggerType: "DATE_OR_MILEAGE",
      intervalDays: 30,
      intervalMiles: 5000,
      leadDays: 0,
      leadMiles: 300,
    });
    const now = new Date(rule.createdAt.getTime() + 31 * DAY_MS);
    expect(evaluateRule(rule, 500, now).isDue).toBe(true);
  });

  it("is due when only the mileage leg has triggered", () => {
    const rule = makeRule({
      triggerType: "DATE_OR_MILEAGE",
      intervalDays: 365,
      intervalMiles: 5000,
      leadDays: 0,
      leadMiles: 300,
    });
    const now = new Date(rule.createdAt.getTime() + DAY_MS);
    expect(evaluateRule(rule, 4800, now).isDue).toBe(true);
  });

  it("is not due when neither leg has triggered", () => {
    const rule = makeRule({
      triggerType: "DATE_OR_MILEAGE",
      intervalDays: 365,
      intervalMiles: 5000,
      leadDays: 0,
      leadMiles: 300,
    });
    const now = new Date(rule.createdAt.getTime() + DAY_MS);
    expect(evaluateRule(rule, 500, now).isDue).toBe(false);
  });
});

describe("evaluateRule: ONE_TIME_DATE", () => {
  it("is not due well before the due date", () => {
    const oneTimeDate = new Date("2027-01-01T00:00:00Z");
    const rule = makeRule({ triggerType: "ONE_TIME_DATE", oneTimeDate, leadDays: 7 });
    expect(evaluateRule(rule, null, new Date("2026-01-01T00:00:00Z")).isDue).toBe(false);
  });

  it("becomes due inside the lead window and stays due after", () => {
    const oneTimeDate = new Date("2027-01-01T00:00:00Z");
    const rule = makeRule({ triggerType: "ONE_TIME_DATE", oneTimeDate, leadDays: 7 });
    expect(evaluateRule(rule, null, new Date("2026-12-27T00:00:00Z")).isDue).toBe(true);
    expect(evaluateRule(rule, null, new Date("2027-06-01T00:00:00Z")).isDue).toBe(true);
  });

  it("is never due if no date was set", () => {
    const rule = makeRule({ triggerType: "ONE_TIME_DATE", oneTimeDate: null });
    expect(evaluateRule(rule, null).isDue).toBe(false);
  });
});
