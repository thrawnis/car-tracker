import React from "react";

interface VaultContextValue {
  /** The unwrapped data key for this session, or null if the vault is locked. */
  dataKey: CryptoKey | null;
  setDataKey: (key: CryptoKey | null) => void;
}

export const VaultContext = React.createContext<VaultContextValue | null>(null);

export function useVault() {
  const ctx = React.useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used within a VaultContext.Provider");
  return ctx;
}

/**
 * Holds the vault's data key in memory only - never localStorage/sessionStorage,
 * never sent anywhere. It's lost on page refresh by design: the server cannot
 * hand it back (it never has it), so refreshing re-locks the vault and the app
 * must prompt for the password (or recovery key) again to re-derive it.
 */
export function useVaultState(): VaultContextValue {
  const [dataKey, setDataKey] = React.useState<CryptoKey | null>(null);
  return { dataKey, setDataKey };
}
