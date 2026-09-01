import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import {
  parseRecoveryKey,
  deriveRecoveryUnwrapKey,
  deriveRecoveryVerifier,
  unwrapKey,
  generateSaltB64,
  deriveKeyFromPassword,
  wrapKey,
} from "@/crypto/vault";

type Step = "email" | "recoveryKey" | "newPassword" | "done";

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Held only for the duration of this flow, in component state (not module-level
  // pending storage) since this page never navigates away mid-flow.
  const [vaultKeyWrappedByRecovery, setVaultKeyWrappedByRecovery] = useState<string | null>(null);
  const [recoveredDataKey, setRecoveredDataKey] = useState<CryptoKey | null>(null);
  const [recoveryRaw, setRecoveryRaw] = useState<Uint8Array | null>(null);

  async function onSubmitEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/recovery/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { vaultKeyWrappedByRecovery?: string; error?: string };
      if (!res.ok || !data.vaultKeyWrappedByRecovery) {
        setError(data.error ?? "Something went wrong");
        return;
      }
      setVaultKeyWrappedByRecovery(data.vaultKeyWrappedByRecovery);
      setStep("recoveryKey");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitRecoveryKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const raw = parseRecoveryKey(recoveryKeyInput);
      const unwrapKeyMaterial = await deriveRecoveryUnwrapKey(raw);
      const dataKey = await unwrapKey(vaultKeyWrappedByRecovery!, unwrapKeyMaterial);
      setRecoveredDataKey(dataKey);
      setRecoveryRaw(raw);
      setStep("newPassword");
    } catch {
      setError("That recovery key doesn't match this account.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      const newVaultSalt = generateSaltB64();
      const wrappingKey = await deriveKeyFromPassword(newPassword, newVaultSalt);
      const newVaultKeyWrappedByPassword = await wrapKey(recoveredDataKey!, wrappingKey);
      const recoveryVerifierProof = await deriveRecoveryVerifier(recoveryRaw!);

      const res = await fetch("/api/auth/recovery/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          recoveryVerifierProof,
          newPassword,
          newVaultSalt,
          newVaultKeyWrappedByPassword,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not reset password");
        return;
      }
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        {step === "email" && (
          <>
            <CardHeader>
              <CardTitle>Reset your password</CardTitle>
              <CardDescription>
                You'll need the one-time recovery key you saved when you created your account. Without it, your
                data can't be recovered — we never have a way to decrypt it either.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmitEmail} className="flex flex-col gap-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Continuing…" : "Continue"}
                </Button>
              </form>
            </CardContent>
          </>
        )}

        {step === "recoveryKey" && (
          <>
            <CardHeader>
              <CardTitle>Enter your recovery key</CardTitle>
              <CardDescription>The one shown once when you created your account.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmitRecoveryKey} className="flex flex-col gap-4">
                <div>
                  <Label htmlFor="recoveryKey">Recovery key</Label>
                  <Input
                    id="recoveryKey"
                    autoFocus
                    required
                    className="font-mono"
                    placeholder="XXXXX-XXXXX-XXXXX-..."
                    value={recoveryKeyInput}
                    onChange={(e) => setRecoveryKeyInput(e.target.value)}
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Checking…" : "Continue"}
                </Button>
              </form>
            </CardContent>
          </>
        )}

        {step === "newPassword" && (
          <>
            <CardHeader>
              <CardTitle>Choose a new password</CardTitle>
              <CardDescription>This replaces your old password. Your recovery key stays the same.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmitNewPassword} className="flex flex-col gap-4">
                <div>
                  <Label htmlFor="newPassword">New password</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    required
                    minLength={12}
                    autoFocus
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="confirmPassword">Confirm new password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving…" : "Reset password"}
                </Button>
              </form>
            </CardContent>
          </>
        )}

        {step === "done" && (
          <>
            <CardHeader>
              <CardTitle>Password reset</CardTitle>
              <CardDescription>
                You've been signed out of all devices for security. Sign in with your new password.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button className="w-full" onClick={() => navigate("/login", { replace: true })}>
                Go to sign in
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
