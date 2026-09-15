import { createContext, useContext } from "react";

export type Role = "super_admin" | "client_admin" | "client_manager" | "client_employee";

export interface AuthUser {
  userId: string;
  username: string;
  email: string | null;
  role: Role;
  organizationId: string | null;
  organizationName?: string | null;
  organizationLogoDataUrl?: string | null;
  licensedModules: string[] | "*";
  /** Epoch ms of the login backing this session; changes on every fresh login. */
  sessionStartedAt?: number | null;
  /** IANA zone of the site the cameras are at, e.g. "Asia/Kolkata". */
  timezone?: string | null;
}

/**
 * Do two /api/auth/me results describe the SAME signed-in session?
 *
 * Session cookies are scoped to the browser PROFILE, not the tab. A second
 * login in another tab silently rebinds every open tab to the new user, so a
 * tab must be able to notice and stop rendering the previous user's data.
 * sessionStartedAt also catches the same person logging in again, which a
 * userId comparison alone would miss.
 */
export function isSameSession(a: AuthUser | null, b: AuthUser | null): boolean {
  if (!a || !b) return a === b;
  return a.userId === b.userId && (a.sessionStartedAt ?? null) === (b.sessionStartedAt ?? null);
}

export const AuthContext = createContext<AuthUser | null>(null);

export function useAuth(): AuthUser {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthContext provider");
  return ctx;
}

// Role capability helpers — mirror the server's enforcement so the UI hides
// what the API would reject anyway (server remains the source of truth).
export function canWrite(role: Role): boolean {
  return role === "client_manager" || role === "client_admin" || role === "super_admin";
}
export function canManageOrgUsers(role: Role): boolean {
  return role === "client_admin";
}
export function hasModule(user: AuthUser, key: string): boolean {
  return user.licensedModules === "*" || user.licensedModules.includes(key);
}

/**
 * Does the user hold ANY of these features?
 *
 * A licence is per FEATURE, but a screen serves a MODULE. Gating the Vehicles
 * screen on `vehicle_count` alone hid it from a client who had bought only
 * wrong-way driving — they were paying for a feature with no way to see its
 * events. Screens must therefore gate on the whole feature set they display.
 */
export function hasAnyModule(user: AuthUser, keys: readonly string[]): boolean {
  return keys.some((k) => hasModule(user, k));
}
