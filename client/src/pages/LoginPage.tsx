import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { setPendingPassword, setPendingDataKey } from "@/crypto/pending";
import { deriveKeyFromPassword, unwrapKey } from "@/crypto/vault";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const httpRes = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await httpRes.json()) as {
        mfaToken?: string;
        enrollToken?: string;
        needsEmailVerification?: boolean;
        vaultSalt?: string;
        vaultKeyWrappedByPassword?: string;
        error?: string;
      };

      if (data.enrollToken) {
        // Resuming an interrupted enrollment - possibly in a browser session
        // that never held the data key generated at registration - so
        // re-derive it here from the password just entered.
        if (data.vaultSalt && data.vaultKeyWrappedByPassword) {
          try {
            const wrappingKey = await deriveKeyFromPassword(password, data.vaultSalt);
            const dataKey = await unwrapKey(data.vaultKeyWrappedByPassword, wrappingKey);
            setPendingDataKey(dataKey);
          } catch {
            // Wrapped fields came back malformed/corrupted; let the next step
            // (verify-email or TOTP setup) surface the failure naturally.
          }
        }
        navigate(data.needsEmailVerification ? "/verify-email" : "/totp-setup", {
          state: { enrollToken: data.enrollToken, email },
        });
        return;
      }
      if (!httpRes.ok || !data.mfaToken) {
        setError(data.error ?? "Login failed");
        return;
      }
      // Held in memory only: needed one more step further, to derive the vault
      // key once TOTP verification confirms the session.
      setPendingPassword(password);
      navigate("/totp-verify", { state: { mfaToken: data.mfaToken } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Track your vehicles, maintenance, and fuel.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link to="/forgot-password" className="text-xs text-brand-600 hover:underline">
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            No account?{" "}
            <Link to="/register" className="text-brand-600 hover:underline">
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
