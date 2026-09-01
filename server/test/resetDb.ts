import { prisma } from "../src/lib/db.js";

/** Truncates every app table so each test starts from a clean database. */
export async function resetDb(): Promise<void> {
  await prisma.$transaction([
    prisma.reminder.deleteMany(),
    prisma.reminderRule.deleteMany(),
    prisma.odometerReading.deleteMany(),
    prisma.fuelLog.deleteMany(),
    prisma.maintenanceRecord.deleteMany(),
    prisma.vehicle.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.session.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}
