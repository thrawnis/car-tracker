import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import type { Vehicle } from "@/api/types";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus } from "lucide-react";

export function VehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ year: "", make: "", model: "", nickname: "" });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setVehicles(await api.get<Vehicle[]>("/vehicles"));
  }

  useEffect(() => {
    void load();
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/vehicles", {
        year: form.year ? Number(form.year) : null,
        make: form.make || null,
        model: form.model || null,
        nickname: form.nickname || null,
      });
      setForm({ year: "", make: "", model: "", nickname: "" });
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create vehicle");
    }
  }

  const current = vehicles?.filter((v) => v.ownershipStatus === "OWNED") ?? [];
  const past = vehicles?.filter((v) => v.ownershipStatus !== "OWNED") ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Vehicles</h1>
          <p className="text-slate-500">Cars you own now and ones you've owned in the past.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Add vehicle
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a vehicle</DialogTitle>
            </DialogHeader>
            <form onSubmit={onCreate} className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label htmlFor="year">Year</Label>
                  <Input
                    id="year"
                    inputMode="numeric"
                    value={form.year}
                    onChange={(e) => setForm({ ...form, year: e.target.value })}
                  />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="make">Make</Label>
                  <Input id="make" value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} />
                </div>
              </div>
              <div>
                <Label htmlFor="model">Model</Label>
                <Input id="model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="nickname">Nickname (optional)</Label>
                <Input
                  id="nickname"
                  value={form.nickname}
                  onChange={(e) => setForm({ ...form, nickname: e.target.value })}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit">Add vehicle</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Current ({current.length})</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {current.map((v) => (
            <VehicleCard key={v.id} vehicle={v} />
          ))}
        </div>
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Past ({past.length})</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {past.map((v) => (
              <VehicleCard key={v.id} vehicle={v} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function VehicleCard({ vehicle }: { vehicle: Vehicle }) {
  const title = vehicle.nickname || [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") || "Vehicle";
  return (
    <Link to={`/vehicles/${vehicle.id}`}>
      <Card className="transition-shadow hover:shadow-md">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            {vehicle.ownershipStatus !== "OWNED" && <Badge>{vehicle.ownershipStatus}</Badge>}
          </div>
          <CardDescription>{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
