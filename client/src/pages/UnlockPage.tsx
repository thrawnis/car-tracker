import { useState } from "react";
import { useAuth } from "@/api/auth";
import { useVault } from "@/api/vault";
import { deriveKeyFromPassword, unwrapKey } from "@/crypto/vault";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";

/**
 * Shown whenever there's a valid session but no vault key in memory (almost
 * always: right after a page refresh). The server can't hand the key back -
 * it never has it - so this re-derives it from the password, entirely
 * client-side, with no network round trip.
 */
export function UnlockPage() {
  const { user, logout } = useAuth();
  const { setDataKey } = useVault();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setError(null);
    setSubmitting(true);
    try {
      const wrappingKey = await deriveKeyFromPassword(password, user.vaultSalt);
      const dataKey = await unwrapKey(user.vaultKeyWrappedByPassword, wrappingKey);
      setDataKey(dataKey);
    } catch {
      setError("Incorrect password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Unlock your vault</CardTitle>
          <CardDescription>
            Your session is still active, but your data key isn't kept anywhere except this tab's memory. Enter your
            password to unlock your data again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Unlocking…" : "Unlock"}
            </Button>
            <button
              type="button"
              className="text-sm text-slate-500 hover:underline"
              onClick={() => void logout()}
            >
              Not you? Log out
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
