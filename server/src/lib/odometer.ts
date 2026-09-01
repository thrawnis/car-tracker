import { prisma } from "./db.js";

/** Records an odometer reading and, opportunistically, upgrades reminder-rule progress checks. */
export async function recordOdometerReading(
  vehicleId: string,
  odometer: number,
  readAt: Date,
  source: "manual" | "fuel_log" | "maintenance",
) {
  await prisma.odometerReading.create({
    data: { vehicleId, odometer, readAt, source },
  });
}

export async function getLatestOdometer(vehicleId: string): Promise<number | null> {
  const latest = await prisma.odometerReading.findFirst({
    where: { vehicleId },
    orderBy: { readAt: "desc" },
  });
  return latest?.odometer ?? null;
}
