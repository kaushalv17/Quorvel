// Tiny zero-dep test harness (same as apps/api). Each test file runs in its own
// tsx process and calls summary() at the end (exits non-zero on failure).
import assert from "node:assert"

let passed = 0
let failed = 0
const failures: string[] = []

export function section(name: string): void {
	console.log(`\n${name}`)
}

export async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn()
		passed++
		console.log(`  \u2713 ${name}`)
	} catch (e) {
		failed++
		const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
		failures.push(`${name}: ${msg}`)
		console.log(`  \u2717 ${name}\n    ${msg}`)
	}
}

export function summary(): void {
	console.log(`\n${passed}/${passed + failed} passed`)
	if (failed) {
		console.log(`\nFAILURES:\n${failures.join("\n")}`)
		process.exit(1)
	}
}

export { assert }
