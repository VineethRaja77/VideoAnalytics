// server/rbac.ts
//
// Role-based access control + tenant scoping. Roles (from @shared/schema):
//   super_admin     — platform/developer; no org; sees & manages everything
//   client_admin    — top of one client org; manages org users + all VMS
//   client_manager  — operational control within the org (cameras, streams)
//   client_employee — read-only within the org (live/playback/recordings)
//
// resolveOrgScope is the single choke point for tenant isolation: every
// org-scoped handler derives the target org from it, never from the client.

import type { Request, RequestHandler } from "express";
import type { Role } from "@shared/schema";

export const ROLE_RANK: Record<Role, number> = {
  client_employee: 1,
  client_manager: 2,
  client_admin: 3,
  super_admin: 4,
};

/** Require the caller to hold one of the given roles. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    const role = req.user?.role as Role | undefined;
    if (!role) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(role)) {
      return res.status(403).json({ error: "Insufficient role", required: roles, actual: role });
    }
    next();
  };
}

/** Require at least the given role rank (e.g. client_manager ⇒ manager or admin or super_admin). */
export function requireMinRole(min: Role): RequestHandler {
  return (req, res, next) => {
    const role = req.user?.role as Role | undefined;
    if (!role) return res.status(401).json({ error: "Not authenticated" });
    if (ROLE_RANK[role] < ROLE_RANK[min]) {
      return res.status(403).json({ error: "Insufficient role", required: min, actual: role });
    }
    next();
  };
}

export const requireSuperAdmin = requireRole("super_admin");

/**
 * The org a request operates on. Client roles are hard-scoped to their own
 * org. super_admin has no org of their own, so they may target one explicitly
 * via ?orgId= or a body.organizationId (used by the admin console). Returns
 * null when no org can be resolved.
 */
export function resolveOrgScope(req: Request): string | null {
  const user = req.user;
  if (!user) return null;

  if (user.role === "super_admin") {
    const fromQuery = (req.query.orgId as string | undefined) || undefined;
    const fromBody = (req.body && (req.body.organizationId as string | undefined)) || undefined;
    return fromQuery || fromBody || null;
  }

  return user.organizationId ?? null;
}

/** Convenience: caller can write (create/update/delete) VMS resources. */
export const requireWriteAccess = requireMinRole("client_manager");
