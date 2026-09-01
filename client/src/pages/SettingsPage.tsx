import { useState } from "react";
import { useAuth } from "@/api/auth";
import { api, getAccessToken } from "@/api/client";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function SettingsPage() {
  const { user, refreshUser } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-slate-500">Reminder preferences and account backup.</p>
      </div>

      <ReminderPrefsCard user={user} onSaved={refreshUser} />
      <ExportCard />
      <ImportCard />
    </div>
  );
}

function ReminderPrefsCard({ user, onSaved }: { user: ReturnType<typeof useAuth>["user"]; onSaved: () => Promise<void> }) {
  const [reminderEmail, setReminderEmail] = useState(user?.reminderEmail ?? "");
  const [reminderLeadDays, setReminderLeadDays] = useState(String(user?.reminderLeadDays ?? 7));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await api.patch("/auth/me", {
        reminderEmail: reminderEmail || null,
        reminderLeadDays: Number(reminderLeadDays),
      });
      await onSaved();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reminder emails</CardTitle>
        <CardDescription>Where and how far ahead of due dates to send reminder emails.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSave} className="flex flex-col gap-4 sm:max-w-sm">
          <div>
            <Label htmlFor="reminderEmail">Reminder email (defaults to your login email)</Label>
            <Input
              id="reminderEmail"
              type="email"
              placeholder={user?.email}
              value={reminderEmail}
              onChange={(e) => setReminderEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="leadDays">Default lead time (days before due date)</Label>
            <Input
              id="leadDays"
              inputMode="numeric"
              value={reminderLeadDays}
              onChange={(e) => setReminderLeadDays(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={saving} className="self-start">
            {saving ? "Saving…" : "Save"}
          </Button>
          {saved && <p className="text-sm text-emerald-600">Saved.</p>}
        </form>
      </CardContent>
    </Card>
  );
}

function ExportCard() {
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onExport(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/backup/export", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
        },
        body: JSON.stringify({ password, passphrase }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `car-tracker-backup-${Date.now()}.ctbackup`;
      a.click();
      URL.revokeObjectURL(url);
      setPassword("");
      setPassphrase("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export a backup</CardTitle>
        <CardDescription>
          Downloads all of your vehicles, maintenance, fuel, and reminder data as one file, encrypted with a
          passphrase you choose. Keep the passphrase somewhere safe — it's the only way to decrypt the file.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onExport} className="flex flex-col gap-4 sm:max-w-sm">
          <div>
            <Label htmlFor="exportPassword">Your account password</Label>
            <Input
              id="exportPassword"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="exportPassphrase">Backup file passphrase</Label>
            <Input
              id="exportPassphrase"
              type="password"
              required
              minLength={8}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={busy} className="self-start">
            {busy ? "Preparing…" : "Download backup"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ImportCard() {
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onImport(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (!file) {
      setError("Choose a backup file");
      return;
    }
    if (!confirm("This will REPLACE all vehicles and history in this account with the contents of the backup. Continue?")) {
      return;
    }
    setBusy(true);
    try {
      const fileContents = await file.text();
      await api.post("/backup/import", { password, passphrase, fileContents, confirmReplace: true });
      setSuccess(true);
      setPassword("");
      setPassphrase("");
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Restore from a backup</CardTitle>
        <CardDescription className="text-amber-700">
          Warning: restoring replaces all vehicles and history currently in this account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onImport} className="flex flex-col gap-4 sm:max-w-sm">
          <div>
            <Label htmlFor="backupFile">Backup file</Label>
            <input
              id="backupFile"
              type="file"
              accept=".ctbackup,application/octet-stream"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
          </div>
          <div>
            <Label htmlFor="importPassword">Your account password</Label>
            <Input
              id="importPassword"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="importPassphrase">Backup file passphrase</Label>
            <Input
              id="importPassphrase"
              type="password"
              required
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {success && <p className="text-sm text-emerald-600">Restore complete.</p>}
          <Button type="submit" variant="destructive" disabled={busy} className="self-start">
            {busy ? "Restoring…" : "Restore backup"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
