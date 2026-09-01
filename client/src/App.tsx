import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthContext, useAuthState, useAuth } from "@/api/auth";
import { VaultContext, useVaultState, useVault } from "@/api/vault";
import { AppLayout } from "@/components/AppLayout";
import { UnlockPage } from "@/pages/UnlockPage";
import { LoginPage } from "@/pages/LoginPage";
import { RegisterPage } from "@/pages/RegisterPage";
import { RecoveryKeyPage } from "@/pages/RecoveryKeyPage";
import { VerifyEmailPage } from "@/pages/VerifyEmailPage";
import { TotpSetupPage } from "@/pages/TotpSetupPage";
import { TotpVerifyPage } from "@/pages/TotpVerifyPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { VehiclesPage } from "@/pages/VehiclesPage";
import { VehicleDetailPage } from "@/pages/VehicleDetailPage";
import { SettingsPage } from "@/pages/SettingsPage";

function ProtectedLayout() {
  const { user, loading } = useAuth();
  const { dataKey } = useVault();

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-500">Loading…</div>;
  }
  if (!user) return <Navigate to="/login" replace />;

  // Session is valid (the server confirmed that), but the vault key only ever
  // lives in memory and is gone after a page refresh - the server has no way
  // to hand it back, so re-derive it from the password before showing any
  // vehicle data.
  if (!dataKey) return <UnlockPage />;

  return <AppLayout />;
}

export default function App() {
  const auth = useAuthState();
  const vault = useVaultState();

  return (
    <AuthContext.Provider value={auth}>
      <VaultContext.Provider value={vault}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/recovery-key" element={<RecoveryKeyPage />} />
            <Route path="/totp-setup" element={<TotpSetupPage />} />
            <Route path="/totp-verify" element={<TotpVerifyPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />

            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/vehicles" element={<VehiclesPage />} />
              <Route path="/vehicles/:vehicleId" element={<VehicleDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </VaultContext.Provider>
    </AuthContext.Provider>
  );
}
