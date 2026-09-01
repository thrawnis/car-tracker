import React from "react";
import { api, setAccessToken, apiFetch } from "./client";

export interface Me {
  id: string;
  username: string;
  email: string;
  timezone: string;
  reminderEmail: string | null;
  reminderLeadDays: number;
  // Opaque vault-unwrap material - safe to hold in auth state; useless without
  // the account's password or recovery key. See crypto/vault.ts.
  vaultSalt: string;
  vaultKeyWrappedByPassword: string;
}

interface AuthContextValue {
  user: Me | null;
  loading: boolean;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export function useAuthState(): AuthContextValue {
  const [user, setUser] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refreshUser = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { accessToken: string };
        setAccessToken(data.accessToken);
        const me = await api.get<Me>("/auth/me");
        setUser(me);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const logout = React.useCallback(async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    setAccessToken(null);
    setUser(null);
  }, []);

  return { user, loading, refreshUser, logout };
}
