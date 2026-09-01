import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";

interface VerifyEmailState {
  enrollToken?: string;
  email?: string;
  recoveryKeyDisplay?: string;
}

export function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as VerifyEmailState | null;
  const enrollToken = state?.enrollToken;

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(false);

  if (!enrollToken) {
    navigate("/login", { replace: true });
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollToken, code }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Invalid or expired code");
        return;
      }

      // If we just registered, the recovery key is still waiting to be shown;
      // if we're resuming an interrupted enrollment after a fresh login, it
      // was already shown once at the original registration and isn't
      // available here again - go straight to TOTP setup.
      if (state?.recoveryKeyDisplay) {
        navigate("/recovery-key", { state: { enrollToken, recoveryKeyDisplay: state.recoveryKeyDisplay } });
      } else {
        navigate("/totp-setup", { state: { enrollToken } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    setError(null);
    setResent(false);
    try {
      const res = await fetch("/api/auth/verify-email/resend", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollToken }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not resend code");
        return;
      }
      setResent(true);
      setResendCooldown(true);
      setTimeout(() => setResendCooldown(false), 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend code");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Verify your email</CardTitle>
          <CardDescription>
            We sent a 6-digit code to {state?.email ?? "your email address"}. Enter it below to continue - the
            code expires in 15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="code">Verification code</Label>
              <Input
                id="code"
                autoFocus
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {resent && <p className="text-sm text-emerald-600">A new code has been sent.</p>}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Verifying…" : "Verify"}
            </Button>
            <button
              type="button"
              className="text-sm text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
              disabled={resendCooldown}
              onClick={() => void onResend()}
            >
              {resendCooldown ? "Code sent - wait a moment before resending" : "Resend code"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
