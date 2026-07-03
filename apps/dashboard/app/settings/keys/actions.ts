"use server"

import { revalidatePath } from "next/cache"
import { serverClient } from "@/lib/server-client"
import { requireAdmin } from "@/lib/authz"
import type { ApiKeyPublic } from "@/lib/quorvel"

// Server actions for self-serve API-key management (Phase 1). Each resolves the
// caller's org from the Clerk session inside serverClient(), so a client can
// never act on another org's keys. requireAdmin() additionally restricts these
// org-wide, credential-minting operations to organization admins.

export async function createKeyAction(input: {
  name?: string
  env?: string
}): Promise<{ apiKey: string; key: ApiKeyPublic }> {
  await requireAdmin()
  const env = input.env === "test" ? "test" : "live"
  const res = await serverClient().createKey({ name: input.name, env })
  revalidatePath("/settings/keys")
  return res
}

export async function rotateKeyAction(
  id: string,
): Promise<{ apiKey: string; key: ApiKeyPublic }> {
  await requireAdmin()
  const res = await serverClient().rotateKey(id)
  revalidatePath("/settings/keys")
  return res
}

export async function revokeKeyAction(id: string): Promise<{ revoked: boolean }> {
  await requireAdmin()
  const res = await serverClient().revokeKey(id)
  revalidatePath("/settings/keys")
  return res
}