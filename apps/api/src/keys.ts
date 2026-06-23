// API key generation, hashing, and display prefixes.
// Keys look like `qrv_live_<random>`; only the SHA-256 hash is stored at rest.
import { createHash, randomBytes, randomUUID } from "node:crypto"

const PREFIX_LEN = 12

export type KeyEnv = "live" | "test"

/** Generate a fresh plaintext API key. Show this to the user exactly once. */
export function generateApiKey(env: KeyEnv = "live"): string {
	const secret = randomBytes(24).toString("base64url")
	return `qrv_${env}_${secret}`
}

/** Deterministic SHA-256 hash used for lookups; the plaintext is never stored. */
export function hashApiKey(key: string): string {
	return createHash("sha256").update(key).digest("hex")
}

/** Short, safe-to-display prefix, e.g. `qrv_live_ab`. */
export function keyPrefix(key: string): string {
	return key.slice(0, PREFIX_LEN)
}

/** Prefixed unique id, e.g. `org_3f2a...`. */
export function newId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, "")}`
}
