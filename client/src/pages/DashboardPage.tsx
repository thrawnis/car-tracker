import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import type { DueReminder } from "@/api/types";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, X } from "lucide-react";

function vehicleLabel(v: DueReminder["vehicle"]) {
  return [v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
}

export function DashboardPage() {
  const [reminders, setReminders] = useState<DueReminder[] | null>(null);

  async function load() {
    setReminders(await api.get<DueReminder[]>("/reminders"));
  }

  useEffect(() => {
    void load();
  }, []);

  async function complete(id: string) {
    await api.post(`/reminders/${id}/complete`);
    await load();
  }

  async function dismiss(id: string) {
    await api.post(`/reminders/${id}/dismiss`);
    await load();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-slate-500">Upcoming and overdue maintenance across all your vehicles.</p>
      </div>

      {reminders?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-slate-500">
            <Check className="h-8 w-8 text-emerald-500" />
            <p>No reminders due right now.</p>
            <Link to="/vehicles" className="text-brand-600 hover:underline">
              Manage vehicles and reminders
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {reminders?.map((r) => (
          <Card key={r.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{r.ruleName}</CardTitle>
                  <CardDescription>{vehicleLabel(r.vehicle)}</CardDescription>
                </div>
                <Badge variant={r.status === "DUE" ? "warning" : "default"}>
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  {r.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-slate-600">
                {r.dueDate && `Due ${new Date(r.dueDate).toLocaleDateString()}`}
                {r.dueDate && r.dueOdometer && " or "}
                {r.dueOdometer && `${r.dueOdometer.toLocaleString()} miles`}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void complete(r.id)}>
                  <Check className="mr-1 h-3.5 w-3.5" /> Mark done
                </Button>
                <Button size="sm" variant="outline" onClick={() => void dismiss(r.id)}>
                  <X className="mr-1 h-3.5 w-3.5" /> Dismiss
                </Button>
                <Link to={`/vehicles/${r.vehicleId}`} className="ml-auto self-center text-sm text-brand-600 hover:underline">
                  View vehicle
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
