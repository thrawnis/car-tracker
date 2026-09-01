import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { loadOwnedVehicle, vehicleIdParam } from "../lib/ownership.js";
import { recordOdometerReading } from "../lib/odometer.js";

export const odometerRouter = Router({ mergeParams: true });
odometerRouter.use(requireAuth);

const schema = z.object({
  odometer: z.number().int().nonnegative(),
  readAt: z.coerce.date().optional(),
});

odometerRouter.get("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const readings = await prisma.odometerReading.findMany({
    where: { vehicleId: vehicle.id },
    orderBy: { readAt: "desc" },
    take: 200,
  });
  res.json(readings);
});

odometerRouter.post("/", async (req, res) => {
  const vehicle = await loadOwnedVehicle(req, res, vehicleIdParam(req));
  if (!vehicle) return;

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  await recordOdometerReading(vehicle.id, parsed.data.odometer, parsed.data.readAt ?? new Date(), "manual");
  res.status(201).end();
});
