/**
 * Short-lived, in-memory-only holders for sensitive values that need to survive
 * a client-side navigation within a single auth flow (register -> show recovery
 * key -> TOTP setup; login -> TOTP verify; forgot-password's multi-step form).
 * Never serialized into router state, storage, or anywhere else - just a module
 * variable, cleared as soon as it's consumed.
 */

let pendingDataKey: CryptoKey | null = null;
export function setPendingDataKey(key: CryptoKey | null): void {
  pendingDataKey = key;
}
export function takePendingDataKey(): CryptoKey | null {
  const key = pendingDataKey;
  pendingDataKey = null;
  return key;
}

let pendingPassword: string | null = null;
export function setPendingPassword(password: string | null): void {
  pendingPassword = password;
}
export function takePendingPassword(): string | null {
  const password = pendingPassword;
  pendingPassword = null;
  return password;
}

let pendingRecoveryRaw: Uint8Array | null = null;
export function setPendingRecoveryRaw(raw: Uint8Array | null): void {
  pendingRecoveryRaw = raw;
}
export function takePendingRecoveryRaw(): Uint8Array | null {
  const raw = pendingRecoveryRaw;
  pendingRecoveryRaw = null;
  return raw;
}
