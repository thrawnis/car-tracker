import type { ReminderRule } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { getLatestOdometer } from "../lib/odometer.js";
import { sendMail } from "./mailer.js";
import pino from "pino";

const logger = pino({ name: "reminder-engine" });

export interface DueCheck {
  isDue: boolean;
  dueDate: Date | null;
  dueOdometer: number | null;
  reason: string;
}

/**
 * Pure trigger-type logic, exported for direct unit testing. Takes `now` explicitly
 * so tests don't depend on the wall clock or need to fabricate elapsed time via the DB.
 */
export function evaluateRule(rule: ReminderRule, currentOdometer: number | null, now: Date = new Date()): DueCheck {
  if (rule.triggerType === "ONE_TIME_DATE") {
    const dueDate = rule.oneTimeDate;
    if (!dueDate) return { isDue: false, dueDate: null, dueOdometer: null, reason: "" };
    const leadDate = new Date(dueDate.getTime() - rule.leadDays * 24 * 60 * 60 * 1000);
    return { isDue: now >= leadDate, dueDate, dueOdometer: null, reason: `due ${dueDate.toDateString()}` };
  }

  let dateDue: Date | null = null;
  let dateIsDue = false;
  if (rule.triggerType === "DATE_INTERVAL" || rule.triggerType === "DATE_OR_MILEAGE") {
    const baseDate = rule.lastCompletedAt ?? rule.createdAt;
    if (rule.intervalDays) {
      dateDue = new Date(baseDate.getTime() + rule.intervalDays * 24 * 60 * 60 * 1000);
      const leadDate = new Date(dateDue.getTime() - rule.leadDays * 24 * 60 * 60 * 1000);
      dateIsDue = now >= leadDate;
    }
  }

  let mileageDue: number | null = null;
  let mileageIsDue = false;
  if (rule.triggerType === "MILEAGE_INTERVAL" || rule.triggerType === "DATE_OR_MILEAGE") {
    const baseOdometer = rule.lastCompletedOdometer ?? 0;
    if (rule.intervalMiles && currentOdometer !== null) {
      mileageDue = baseOdometer + rule.intervalMiles;
      mileageIsDue = currentOdometer >= mileageDue - rule.leadMiles;
    }
  }

  if (rule.triggerType === "DATE_INTERVAL") {
    return {
      isDue: dateIsDue,
      dueDate: dateDue,
      dueOdometer: null,
      reason: dateDue ? `due ${dateDue.toDateString()}` : "",
    };
  }
  if (rule.triggerType === "MILEAGE_INTERVAL") {
    return {
      isDue: mileageIsDue,
      dueDate: null,
      dueOdometer: mileageDue,
      reason: mileageDue ? `due at ${mileageDue} miles` : "",
    };
  }

  // DATE_OR_MILEAGE: whichever comes first triggers the reminder.
  return {
    isDue: dateIsDue || mileageIsDue,
    dueDate: dateDue,
    dueOdometer: mileageDue,
    reason: [dateDue ? `due ${dateDue.toDateString()}` : null, mileageDue ? `due at ${mileageDue} miles` : null]
      .filter(Boolean)
      .join(" or "),
  };
}

/** Evaluates every active reminder rule across all accounts and emails newly-due reminders. */
export async function runReminderSweep(): Promise<void> {
  const rules = await prisma.reminderRule.findMany({
    where: { active: true },
    include: { vehicle: { include: { user: true } } },
  });

  for (const rule of rules) {
    try {
      const currentOdometer = await getLatestOdometer(rule.vehicleId);
      const check = evaluateRule(rule, currentOdometer);

      let reminder = await prisma.reminder.findFirst({
        where: { reminderRuleId: rule.id, status: { in: ["PENDING", "DUE"] } },
      });

      if (!check.isDue) {
        continue;
      }

      if (!reminder) {
        reminder = await prisma.reminder.create({
          data: {
            reminderRuleId: rule.id,
            status: "DUE",
            dueDate: check.dueDate,
            dueOdometer: check.dueOdometer,
          },
        });
      } else if (reminder.status !== "DUE") {
        reminder = await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: "DUE", dueDate: check.dueDate, dueOdometer: check.dueOdometer },
        });
      }

      if (!reminder.notifiedAt) {
        const user = rule.vehicle.user;
        const to = user.reminderEmail ?? user.email;
        const vehicleName = [rule.vehicle.year, rule.vehicle.make, rule.vehicle.model].filter(Boolean).join(" ");

        await sendMail({
          to,
          subject: `Reminder: ${rule.name} ${vehicleName ? `for ${vehicleName}` : ""}`.trim(),
          text: `Your reminder "${rule.name}" is ${check.reason}.`,
          html: `<p>Your reminder <strong>${rule.name}</strong>${
            vehicleName ? ` for ${vehicleName}` : ""
          } is ${check.reason}.</p>`,
        });

        await prisma.reminder.update({ where: { id: reminder.id }, data: { notifiedAt: new Date() } });
      }
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, "Failed to evaluate/notify reminder rule");
    }
  }
}
