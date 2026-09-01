import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import type { Vehicle, MaintenanceRecord, FuelLog, ReminderRule } from "@/api/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2 } from "lucide-react";

function centsToDollars(cents: number | null) {
  return cents == null ? "" : (cents / 100).toFixed(2);
}
function dollarsToCents(dollars: string): number | null {
  if (!dollars) return null;
  return Math.round(Number(dollars) * 100);
}

export function VehicleDetailPage() {
  const { vehicleId } = useParams<{ vehicleId: string }>();
  const navigate = useNavigate();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);

  const loadVehicle = useCallback(async () => {
    if (!vehicleId) return;
    setVehicle(await api.get<Vehicle>(`/vehicles/${vehicleId}`));
  }, [vehicleId]);

  useEffect(() => {
    void loadVehicle();
  }, [loadVehicle]);

  async function onDeleteVehicle() {
    if (!vehicleId) return;
    if (!confirm("Delete this vehicle and all of its maintenance/fuel history? This cannot be undone.")) return;
    await api.delete(`/vehicles/${vehicleId}`);
    navigate("/vehicles");
  }

  if (!vehicle || !vehicleId) return <p className="text-slate-500">Loading…</p>;

  const title = vehicle.nickname || [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{title || "Vehicle"}</h1>
          <p className="text-slate-500">{[vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ")}</p>
        </div>
        <div className="flex items-center gap-2">
          {vehicle.ownershipStatus !== "OWNED" && <Badge>{vehicle.ownershipStatus}</Badge>}
          <Button variant="destructive" size="sm" onClick={() => void onDeleteVehicle()}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="fuel">Fuel</TabsTrigger>
          <TabsTrigger value="reminders">Reminders</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab vehicle={vehicle} onSaved={loadVehicle} />
        </TabsContent>
        <TabsContent value="maintenance">
          <MaintenanceTab vehicleId={vehicleId} />
        </TabsContent>
        <TabsContent value="fuel">
          <FuelTab vehicleId={vehicleId} fuelUnit={vehicle.fuelUnit} />
        </TabsContent>
        <TabsContent value="reminders">
          <RemindersTab vehicleId={vehicleId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OverviewTab({ vehicle, onSaved }: { vehicle: Vehicle; onSaved: () => void }) {
  const [form, setForm] = useState({
    vin: vehicle.vin ?? "",
    licensePlate: vehicle.licensePlate ?? "",
    notes: vehicle.notes ?? "",
    ownershipStatus: vehicle.ownershipStatus,
    fuelUnit: vehicle.fuelUnit,
  });
  const [saving, setSaving] = useState(false);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/vehicles/${vehicle.id}`, form);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={onSave} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="vin">VIN</Label>
              <Input id="vin" value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="plate">License plate</Label>
              <Input
                id="plate"
                value={form.licensePlate}
                onChange={(e) => setForm({ ...form, licensePlate: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="status">Ownership status</Label>
              <Select
                id="status"
                value={form.ownershipStatus}
                onChange={(e) => setForm({ ...form, ownershipStatus: e.target.value as Vehicle["ownershipStatus"] })}
              >
                <option value="OWNED">Owned</option>
                <option value="SOLD">Sold</option>
                <option value="TRADED_IN">Traded in</option>
                <option value="TOTALED">Totaled</option>
                <option value="GIFTED">Gifted</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="fuelUnit">Fuel unit</Label>
              <Select
                id="fuelUnit"
                value={form.fuelUnit}
                onChange={(e) => setForm({ ...form, fuelUnit: e.target.value as Vehicle["fuelUnit"] })}
              >
                <option value="GALLONS">Gallons (MPG)</option>
                <option value="LITERS">Liters (L/100km)</option>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <p className="text-xs text-slate-400">VIN, license plate, and notes are stored encrypted.</p>
          <Button type="submit" disabled={saving} className="self-start">
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MaintenanceTab({ vehicleId }: { vehicleId: string }) {
  const [records, setRecords] = useState<MaintenanceRecord[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ serviceType: "", performedAt: "", odometer: "", vendor: "", cost: "", notes: "" });

  const load = useCallback(async () => {
    setRecords(await api.get<MaintenanceRecord[]>(`/vehicles/${vehicleId}/maintenance`));
  }, [vehicleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    await api.post(`/vehicles/${vehicleId}/maintenance`, {
      serviceType: form.serviceType,
      performedAt: form.performedAt,
      odometer: form.odometer ? Number(form.odometer) : null,
      vendor: form.vendor || null,
      costCents: dollarsToCents(form.cost),
      notes: form.notes || null,
    });
    setForm({ serviceType: "", performedAt: "", odometer: "", vendor: "", cost: "", notes: "" });
    setOpen(false);
    await load();
  }

  async function onDelete(id: string) {
    await api.delete(`/vehicles/${vehicleId}/maintenance/${id}`);
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="self-start">
            <Plus className="mr-1 h-4 w-4" /> Log maintenance
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log maintenance</DialogTitle>
          </DialogHeader>
          <form onSubmit={onCreate} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="serviceType">Service</Label>
              <Input
                id="serviceType"
                required
                placeholder="Oil change"
                value={form.serviceType}
                onChange={(e) => setForm({ ...form, serviceType: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="performedAt">Date</Label>
                <Input
                  id="performedAt"
                  type="date"
                  required
                  value={form.performedAt}
                  onChange={(e) => setForm({ ...form, performedAt: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="odometer">Odometer</Label>
                <Input
                  id="odometer"
                  inputMode="numeric"
                  value={form.odometer}
                  onChange={(e) => setForm({ ...form, odometer: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="vendor">Vendor</Label>
                <Input id="vendor" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="cost">Cost ($)</Label>
                <Input id="cost" inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
              </div>
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <Button type="submit">Save</Button>
          </form>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2">
        {records?.map((r) => (
          <Card key={r.id}>
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <div>
                <p className="font-medium">{r.serviceType}</p>
                <p className="text-sm text-slate-500">
                  {new Date(r.performedAt).toLocaleDateString()}
                  {r.odometer != null && ` · ${r.odometer.toLocaleString()} mi`}
                  {r.vendor && ` · ${r.vendor}`}
                  {r.costCents != null && ` · $${centsToDollars(r.costCents)}`}
                </p>
                {r.notes && <p className="mt-1 text-sm text-slate-600">{r.notes}</p>}
              </div>
              <Button variant="ghost" size="icon" onClick={() => void onDelete(r.id)}>
                <Trash2 className="h-4 w-4 text-slate-400" />
              </Button>
            </CardContent>
          </Card>
        ))}
        {records?.length === 0 && <p className="text-slate-500">No maintenance logged yet.</p>}
      </div>
    </div>
  );
}

function FuelTab({ vehicleId, fuelUnit }: { vehicleId: string; fuelUnit: Vehicle["fuelUnit"] }) {
  const [logs, setLogs] = useState<FuelLog[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ filledAt: "", odometer: "", quantity: "", cost: "", isFull: true, missedFillUp: false });

  const load = useCallback(async () => {
    setLogs(await api.get<FuelLog[]>(`/vehicles/${vehicleId}/fuel`));
  }, [vehicleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    await api.post(`/vehicles/${vehicleId}/fuel`, {
      filledAt: form.filledAt,
      odometer: Number(form.odometer),
      quantity: Number(form.quantity),
      totalCostCents: dollarsToCents(form.cost),
      isFull: form.isFull,
      missedFillUp: form.missedFillUp,
    });
    setForm({ filledAt: "", odometer: "", quantity: "", cost: "", isFull: true, missedFillUp: false });
    setOpen(false);
    await load();
  }

  async function onDelete(id: string) {
    await api.delete(`/vehicles/${vehicleId}/fuel/${id}`);
    await load();
  }

  const unitLabel = fuelUnit === "GALLONS" ? "gal" : "L";
  const economyLabel = fuelUnit === "GALLONS" ? "MPG" : "L/100km";

  return (
    <div className="flex flex-col gap-4">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="self-start">
            <Plus className="mr-1 h-4 w-4" /> Log fill-up
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log fill-up</DialogTitle>
          </DialogHeader>
          <form onSubmit={onCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="filledAt">Date</Label>
                <Input
                  id="filledAt"
                  type="date"
                  required
                  value={form.filledAt}
                  onChange={(e) => setForm({ ...form, filledAt: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="odometer">Odometer</Label>
                <Input
                  id="odometer"
                  inputMode="numeric"
                  required
                  value={form.odometer}
                  onChange={(e) => setForm({ ...form, odometer: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="quantity">Quantity ({unitLabel})</Label>
                <Input
                  id="quantity"
                  inputMode="decimal"
                  required
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="cost">Total cost ($)</Label>
                <Input id="cost" inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isFull}
                onChange={(e) => setForm({ ...form, isFull: e.target.checked })}
              />
              Filled to full
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.missedFillUp}
                onChange={(e) => setForm({ ...form, missedFillUp: e.target.checked })}
              />
              Missed a previous fill-up (breaks economy calc for this interval)
            </label>
            <Button type="submit">Save</Button>
          </form>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2">
        {logs?.map((l) => (
          <Card key={l.id}>
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <div>
                <p className="font-medium">
                  {new Date(l.filledAt).toLocaleDateString()} · {l.odometer.toLocaleString()} mi
                </p>
                <p className="text-sm text-slate-500">
                  {l.quantity} {unitLabel}
                  {l.totalCostCents != null && ` · $${centsToDollars(l.totalCostCents)}`}
                  {l.economy != null && ` · ${l.economy.toFixed(1)} ${economyLabel}`}
                  {!l.isFull && " · partial fill"}
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => void onDelete(l.id)}>
                <Trash2 className="h-4 w-4 text-slate-400" />
              </Button>
            </CardContent>
          </Card>
        ))}
        {logs?.length === 0 && <p className="text-slate-500">No fuel logs yet.</p>}
      </div>
    </div>
  );
}

function RemindersTab({ vehicleId }: { vehicleId: string }) {
  const [rules, setRules] = useState<ReminderRule[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    triggerType: "DATE_INTERVAL" as ReminderRule["triggerType"],
    intervalDays: "",
    intervalMiles: "",
    oneTimeDate: "",
  });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRules(await api.get<ReminderRule[]>(`/vehicles/${vehicleId}/reminder-rules`));
  }, [vehicleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/vehicles/${vehicleId}/reminder-rules`, {
        name: form.name,
        triggerType: form.triggerType,
        intervalDays: form.intervalDays ? Number(form.intervalDays) : null,
        intervalMiles: form.intervalMiles ? Number(form.intervalMiles) : null,
        oneTimeDate: form.oneTimeDate || null,
      });
      setForm({ name: "", triggerType: "DATE_INTERVAL", intervalDays: "", intervalMiles: "", oneTimeDate: "" });
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create reminder");
    }
  }

  async function onToggleActive(rule: ReminderRule) {
    await api.patch(`/vehicles/${vehicleId}/reminder-rules/${rule.id}`, { active: !rule.active });
    await load();
  }

  async function onDelete(id: string) {
    await api.delete(`/vehicles/${vehicleId}/reminder-rules/${id}`);
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="self-start">
            <Plus className="mr-1 h-4 w-4" /> Add reminder
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a reminder</DialogTitle>
          </DialogHeader>
          <form onSubmit={onCreate} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                placeholder="Oil change"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="triggerType">Trigger</Label>
              <Select
                id="triggerType"
                value={form.triggerType}
                onChange={(e) => setForm({ ...form, triggerType: e.target.value as ReminderRule["triggerType"] })}
              >
                <option value="DATE_INTERVAL">Every N days</option>
                <option value="MILEAGE_INTERVAL">Every N miles</option>
                <option value="DATE_OR_MILEAGE">Whichever comes first (days or miles)</option>
                <option value="ONE_TIME_DATE">One-time, on a specific date</option>
              </Select>
            </div>
            {(form.triggerType === "DATE_INTERVAL" || form.triggerType === "DATE_OR_MILEAGE") && (
              <div>
                <Label htmlFor="intervalDays">Every how many days</Label>
                <Input
                  id="intervalDays"
                  inputMode="numeric"
                  value={form.intervalDays}
                  onChange={(e) => setForm({ ...form, intervalDays: e.target.value })}
                />
              </div>
            )}
            {(form.triggerType === "MILEAGE_INTERVAL" || form.triggerType === "DATE_OR_MILEAGE") && (
              <div>
                <Label htmlFor="intervalMiles">Every how many miles</Label>
                <Input
                  id="intervalMiles"
                  inputMode="numeric"
                  value={form.intervalMiles}
                  onChange={(e) => setForm({ ...form, intervalMiles: e.target.value })}
                />
              </div>
            )}
            {form.triggerType === "ONE_TIME_DATE" && (
              <div>
                <Label htmlFor="oneTimeDate">Due date</Label>
                <Input
                  id="oneTimeDate"
                  type="date"
                  value={form.oneTimeDate}
                  onChange={(e) => setForm({ ...form, oneTimeDate: e.target.value })}
                />
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit">Save</Button>
          </form>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2">
        {rules?.map((r) => (
          <Card key={r.id}>
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <div>
                <p className="font-medium">{r.name}</p>
                <p className="text-sm text-slate-500">
                  {r.triggerType === "DATE_INTERVAL" && `Every ${r.intervalDays} days`}
                  {r.triggerType === "MILEAGE_INTERVAL" && `Every ${r.intervalMiles} miles`}
                  {r.triggerType === "DATE_OR_MILEAGE" && `Every ${r.intervalDays} days or ${r.intervalMiles} miles`}
                  {r.triggerType === "ONE_TIME_DATE" && r.oneTimeDate && `Due ${new Date(r.oneTimeDate).toLocaleDateString()}`}
                  {!r.active && " · paused"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void onToggleActive(r)}>
                  {r.active ? "Pause" : "Resume"}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => void onDelete(r.id)}>
                  <Trash2 className="h-4 w-4 text-slate-400" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {rules?.length === 0 && <p className="text-slate-500">No reminders set up yet.</p>}
      </div>
    </div>
  );
}
