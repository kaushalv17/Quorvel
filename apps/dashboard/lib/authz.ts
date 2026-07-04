import { auth } from "@clerk/nextjs/server"

// --- Intra-org authorization (RBAC) ---------------------------------------
// Privileged, org-wide mutations (minting/rotating/revoking API keys, opening
// the billing portal, and creating/editing/deleting alert rules) must be
// restricted to organization admins. Clerk's default org roles are
// "org:admin" and "org:member"; the org creator is always "org:admin".
//
// Enforced in the dashboard server-action layer because every privileged
// mutation flows exclusively through those actions. (API keys themselves are
// org-scoped machine credentials and are intentionally role-agnostic.)

const PRIVILEGED_ROLES = new Set<string>(["org:admin"])

export class ForbiddenError extends Error {
  constructor(
    message = "You don't have permission to do that. Ask an organization admin.",
  ) {
    super(message)
    this.name = "ForbiddenError"
  }
}

// Throws ForbiddenError unless the signed-in user is an admin of the active
// organization. Call at the very top of every privileged server action.
export async function requireAdmin(): Promise<void> {
  const { userId, orgId, orgRole } = await auth()
  if (!userId) throw new ForbiddenError("Not signed in")
  if (!orgId) {
    throw new ForbiddenError(
      "No active organization — create or select one first",
    )
  }
  if (!orgRole || !PRIVILEGED_ROLES.has(orgRole)) throw new ForbiddenError()
}

export async function isAdmin(): Promise<boolean> {
  const { userId, orgId, orgRole } = await auth()
  return Boolean(userId && orgId && orgRole && PRIVILEGED_ROLES.has(orgRole))
}
