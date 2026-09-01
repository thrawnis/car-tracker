import type { Request, Response } from "express";
import { prisma } from "./db.js";

/**
 * Reads `:vehicleId` off a mergeParams sub-router's request. @types/express infers
 * `req.params` from the route's own path template, which for a sub-router mounted at
 * "/" doesn't know about the parent's `:vehicleId` segment even though it's present
 * at runtime via mergeParams — hence the cast.
 */
export function vehicleIdParam(req: Request): string {
  return (req.params as Record<string, string>).vehicleId;
}

/** Loads a vehicle and 404s if it doesn't exist or doesn't belong to the requesting user. */
export async function loadOwnedVehicle(req: Request, res: Response, vehicleId: string) {
  const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, userId: req.userId! } });
  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return null;
  }
  return vehicle;
}
