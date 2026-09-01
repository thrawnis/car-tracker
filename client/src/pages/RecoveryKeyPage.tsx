import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Copy, Check } from "lucide-react";

export function RecoveryKeyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { enrollToken?: string; recoveryKeyDisplay?: string } | null;
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (!state?.enrollToken || !state.recoveryKeyDisplay) {
    navigate("/register", { replace: true });
    return null;
  }

  async function onCopy() {
    await navigator.clipboard.writeText(state!.recoveryKeyDisplay!);
    setCopied(true);
  }

  function onContinue() {
    navigate("/totp-setup", { state: { enrollToken: state!.enrollToken } });
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Save your recovery key</CardTitle>
          <CardDescription>
            This is the <strong>only</strong> way to get back into your account if you forget your password. We
            don't store it, so we can't show it to you again or recover it for you — write it down or save it in a
            password manager now.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-md bg-slate-50 p-4 text-center font-mono text-sm tracking-wide break-all">
            {state.recoveryKeyDisplay}
          </div>
          <Button variant="outline" onClick={() => void onCopy()}>
            {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
            {copied ? "Copied" : "Copy to clipboard"}
          </Button>
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I've saved this recovery key somewhere safe.
          </label>
          <Button disabled={!confirmed} onClick={onContinue}>
            Continue
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
