import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { loadOwnedVehicle, vehicleIdParam } from "../lib/ownership.js";

export const reminderRulesRouter = Router({ mergeParams: true });
reminderRulesRouter.use(requireAuth);

const baseSchema = z.object({
  name: z.string().min(1).max(200),
  triggerType: z.enum(["DATE_INTERVAL", "MILEAGE_INTERVAL", "DATE_OR_MILEAGE", "ONE_TIME_DATE"]),
  intervalDays: z.number().int().positive().nullable().optional(),
  intervalMiles: z.number().int().positive().nullable().optional(),
  oneTimeDate: z.coerce.date().nullable().optional(),
  leadDays: z.number().int().nonnegative().optional(),
  leadMiles: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

function requiresMatchingIntervalFields(d: z.infer<typeof baseSchema>): boolean {
  if (d.triggerType === "DATE_INTERVAL") return !!d.intervalDays;
  if (d.triggerType === "MILEAGE_INTERVAL") return !!d.intervalMiles;
  if (d.triggerType === "DATE_OR_MILEAGE") return !!d.intervalDays && !!d.intervalMiles;
  if (d.triggerType === "ONE_TIME_DATE") return !!d.oneTimeDate;
  return true;
}

const createSchema = baseSchema.refine(requiresMatchingIntervalFields, {
  message: "Missing interval/date fields for the selected trigger type",
});

// Partial updates only re-check the cross-field rule when triggerType is actually being
// changed in this request; otherwise it's validated against the schema's own optionality.
const updateSchema = baseSchema.partial().refine(
  (d) => (d.triggerType ? requiresMatchingIntervalFields(d as z.infer<typeof baseSchema>) : true),
  { message: "Missing interval/date fields for the selected trigger type" },
);

reminderRulesRouter.get("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const rules = await prisma.reminderRule.findMany({
    where: { vehicleId: vehicle.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(rules);
});

reminderRulesRouter.post("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;

  const rule = await prisma.reminderRule.create({
    data: {
      vehicleId: vehicle.id,
      name: d.name,
      triggerType: d.triggerType,
      intervalDays: d.intervalDays ?? null,
      intervalMiles: d.intervalMiles ?? null,
      oneTimeDate: d.oneTimeDate ?? null,
      leadDays: d.leadDays ?? 7,
      leadMiles: d.leadMiles ?? 300,
      active: d.active ?? true,
    },
  });

  res.status(201).json(rule);
});

async function loadOwnedRule(req: import("express").Request, res: import("express").Response, id: string) {
  const rule = await prisma.reminderRule.findFirst({ where: { id, vehicle: { userId: req.userId! } } });
  if (!rule) {
    res.status(404).json({ error: "Reminder rule not found" });
    return null;
  }
  return rule;
}

reminderRulesRouter.patch("/:id", async (req, res) => {
  const rule = await loadOwnedRule(req, res, req.params.id);
  if (!rule) return;

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;

  const updated = await prisma.reminderRule.update({
    where: { id: rule.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.triggerType !== undefined ? { triggerType: d.triggerType } : {}),
      ...(d.intervalDays !== undefined ? { intervalDays: d.intervalDays } : {}),
      ...(d.intervalMiles !== undefined ? { intervalMiles: d.intervalMiles } : {}),
      ...(d.oneTimeDate !== undefined ? { oneTimeDate: d.oneTimeDate } : {}),
      ...(d.leadDays !== undefined ? { leadDays: d.leadDays } : {}),
      ...(d.leadMiles !== undefined ? { leadMiles: d.leadMiles } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
    },
  });

  res.json(updated);
});

reminderRulesRouter.delete("/:id", async (req, res) => {
  const rule = await loadOwnedRule(req, res, req.params.id);
  if (!rule) return;
  await prisma.reminderRule.delete({ where: { id: rule.id } });
  res.status(204).end();
});
