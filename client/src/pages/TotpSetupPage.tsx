import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { setAccessToken } from "@/api/client";
import { useAuth } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";

export function TotpSetupPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const enrollToken = (location.state as { enrollToken?: string } | null)?.enrollToken;

  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!enrollToken) {
      navigate("/login", { replace: true });
      return;
    }
    fetch("/api/auth/totp/setup", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollToken }),
    })
      .then((res) => res.json())
      .then((data: { secret: string; qrCodeDataUrl: string }) => {
        setSecret(data.secret);
        setQrCodeDataUrl(data.qrCodeDataUrl);
      })
      .catch(() => setError("Could not start 2FA setup. Please try registering again."));
  }, [enrollToken, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const httpRes = await fetch("/api/auth/totp/enable", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollToken, code }),
      });
      const data = (await httpRes.json()) as { accessToken?: string; backupCodes?: string[]; error?: string };
      if (!httpRes.ok || !data.accessToken) {
        setError(data.error ?? "Invalid code");
        return;
      }
      setAccessToken(data.accessToken);
      setBackupCodes(data.backupCodes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function onDone() {
    await refreshUser();
    navigate("/", { replace: true });
  }

  if (backupCodes) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Save your backup codes</CardTitle>
            <CardDescription>
              Each code can be used once to sign in if you lose access to your authenticator app. Store them
              somewhere safe — they won't be shown again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-4 font-mono text-sm">
              {backupCodes.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
            <Button className="mt-4 w-full" onClick={() => void onDone()}>
              I've saved my backup codes
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set up two-factor authentication</CardTitle>
          <CardDescription>Scan this QR code with an authenticator app (e.g. Google Authenticator).</CardDescription>
        </CardHeader>
        <CardContent>
          {qrCodeDataUrl && (
            <div className="mb-4 flex flex-col items-center gap-2">
              <img src={qrCodeDataUrl} alt="TOTP QR code" className="h-48 w-48" />
              {secret && <p className="break-all text-center text-xs text-slate-500">Manual entry: {secret}</p>}
            </div>
          )}
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="code">Enter the 6-digit code from your app</Label>
              <Input
                id="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={submitting || !secret}>
              {submitting ? "Verifying…" : "Enable 2FA"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
