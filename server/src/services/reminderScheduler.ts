import cron from "node-cron";
import pino from "pino";
import { env } from "../env.js";
import { runReminderSweep } from "./reminderEngine.js";

const logger = pino({ name: "reminder-scheduler" });

export function startReminderScheduler(): void {
  cron.schedule(env.REMINDER_CRON, () => {
    runReminderSweep().catch((err) => logger.error({ err }, "Reminder sweep failed"));
  });
  logger.info({ cron: env.REMINDER_CRON }, "Reminder scheduler started");
}
