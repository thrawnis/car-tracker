import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";

export const remindersRouter = Router();
remindersRouter.use(requireAuth);

// Top-level, cross-vehicle view of active reminders for the authenticated user's dashboard.
remindersRouter.get("/", async (req, res) => {
  const reminders = await prisma.reminder.findMany({
    where: {
      status: { in: ["PENDING", "DUE"] },
      reminderRule: { vehicle: { userId: req.userId! } },
    },
    include: { reminderRule: { include: { vehicle: true } } },
    orderBy: { dueDate: "asc" },
  });

  res.json(
    reminders.map((r) => ({
      id: r.id,
      status: r.status,
      dueDate: r.dueDate,
      dueOdometer: r.dueOdometer,
      ruleName: r.reminderRule.name,
      vehicleId: r.reminderRule.vehicleId,
      vehicle: {
        year: r.reminderRule.vehicle.year,
        make: r.reminderRule.vehicle.make,
        model: r.reminderRule.vehicle.model,
      },
    })),
  );
});

async function loadOwnedReminder(req: import("express").Request, res: import("express").Response, id: string) {
  const reminder = await prisma.reminder.findFirst({
    where: { id, reminderRule: { vehicle: { userId: req.userId! } } },
  });
  if (!reminder) {
    res.status(404).json({ error: "Reminder not found" });
    return null;
  }
  return reminder;
}

remindersRouter.post("/:id/dismiss", async (req, res) => {
  const reminder = await loadOwnedReminder(req, res, req.params.id);
  if (!reminder) return;
  await prisma.reminder.update({ where: { id: reminder.id }, data: { status: "DISMISSED" } });
  res.status(204).end();
});

remindersRouter.post("/:id/complete", async (req, res) => {
  const reminder = await loadOwnedReminder(req, res, req.params.id);
  if (!reminder) return;

  await prisma.$transaction([
    prisma.reminder.update({ where: { id: reminder.id }, data: { status: "COMPLETED" } }),
    prisma.reminderRule.update({
      where: { id: reminder.reminderRuleId },
      data: { lastCompletedAt: new Date() },
    }),
  ]);

  res.status(204).end();
});
