export type OwnershipStatus = "OWNED" | "SOLD" | "TOTALED" | "TRADED_IN" | "GIFTED";
export type FuelUnit = "GALLONS" | "LITERS";
export type ReminderTriggerType = "DATE_INTERVAL" | "MILEAGE_INTERVAL" | "DATE_OR_MILEAGE" | "ONE_TIME_DATE";
export type ReminderStatus = "PENDING" | "DUE" | "SENT" | "DISMISSED" | "COMPLETED";

export interface Vehicle {
  id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  vin: string | null;
  licensePlate: string | null;
  nickname: string | null;
  notes: string | null;
  ownershipStatus: OwnershipStatus;
  acquiredDate: string | null;
  disposedDate: string | null;
  fuelUnit: FuelUnit;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceRecord {
  id: string;
  vehicleId: string;
  serviceType: string;
  performedAt: string;
  odometer: number | null;
  notes: string | null;
  vendor: string | null;
  costCents: number | null;
  reminderRuleId: string | null;
  createdAt: string;
}

export interface FuelLog {
  id: string;
  vehicleId: string;
  filledAt: string;
  odometer: number;
  quantity: number;
  pricePerUnitCents: number | null;
  totalCostCents: number | null;
  missedFillUp: boolean;
  isFull: boolean;
  notes: string | null;
  economy: number | null;
  createdAt: string;
}

export interface ReminderRule {
  id: string;
  vehicleId: string;
  name: string;
  triggerType: ReminderTriggerType;
  intervalDays: number | null;
  intervalMiles: number | null;
  oneTimeDate: string | null;
  lastCompletedAt: string | null;
  lastCompletedOdometer: number | null;
  leadDays: number;
  leadMiles: number;
  active: boolean;
  createdAt: string;
}

export interface DueReminder {
  id: string;
  status: ReminderStatus;
  dueDate: string | null;
  dueOdometer: number | null;
  ruleName: string;
  vehicleId: string;
  vehicle: { year: number | null; make: string | null; model: string | null };
}
