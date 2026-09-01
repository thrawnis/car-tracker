import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import {
  generateDataKey,
  generateSaltB64,
  deriveKeyFromPassword,
  wrapKey,
  generateRecoveryKey,
  deriveRecoveryUnwrapKey,
  deriveRecoveryVerifier,
} from "@/crypto/vault";
import { setPendingDataKey } from "@/crypto/pending";

export function RegisterPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    try {
      // Everything sensitive here is generated and wrapped in the browser.
      // The server only ever receives the wrapped (opaque) results below.
      const dataKey = await generateDataKey();
      const vaultSalt = generateSaltB64();
      const passwordWrappingKey = await deriveKeyFromPassword(password, vaultSalt);
      const vaultKeyWrappedByPassword = await wrapKey(dataKey, passwordWrappingKey);

      const recovery = generateRecoveryKey();
      const recoveryWrappingKey = await deriveRecoveryUnwrapKey(recovery.raw);
      const vaultKeyWrappedByRecovery = await wrapKey(dataKey, recoveryWrappingKey);
      const recoveryVerifier = await deriveRecoveryVerifier(recovery.raw);

      const httpRes = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          email,
          password,
          vaultSalt,
          vaultKeyWrappedByPassword,
          vaultKeyWrappedByRecovery,
          recoveryVerifier,
        }),
      });
      const data = (await httpRes.json()) as { enrollToken?: string; error?: string };

      if (!httpRes.ok || !data.enrollToken) {
        setError(data.error ?? "Registration failed");
        return;
      }

      // Held in memory only until the verify-email, recovery-key, and
      // TOTP-setup steps finish.
      setPendingDataKey(dataKey);
      navigate("/verify-email", {
        state: { enrollToken: data.enrollToken, email, recoveryKeyDisplay: recovery.display },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            Your data is encrypted in your browser before it's ever sent — we can't read it, even if we wanted
            to. You'll need to confirm your email with a code we send you, then set up two-factor authentication
            (TOTP) and save a one-time recovery key: without your password OR that key, no one (including us) can
            decrypt your data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                required
                minLength={3}
                maxLength={30}
                pattern="[a-zA-Z0-9_.\-]+"
                title="Letters, numbers, underscores, dots, and dashes only"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">At least 12 characters.</p>
            </div>
            <div>
              <Label htmlFor="confirmPassword">Confirm password</Label>
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
              {submitting ? "Creating account…" : "Continue"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link to="/login" className="text-brand-600 hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
