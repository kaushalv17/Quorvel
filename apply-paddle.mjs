#!/usr/bin/env node
// apply-paddle.mjs — wires the Paddle billing module into the Belay cloud API.
//
// Run from the repo ROOT:   node apply-paddle.mjs
//
// - Idempotent: safe to run more than once (already-applied steps are skipped).
// - Fail-loud: throws if an anchor is missing or ambiguous; nothing is half-written
//   because each file is only saved after all its steps succeed.
// - Does NOT touch paddle.ts / paddle.test.ts — copy those two files in yourself.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(process.cwd(), "apps", "api", "src")
let applied = 0
let skipped = 0

const indentOf = (l) => (l.match(/^[ \t]*/) || [""])[0]

function idx(ls, trimEq) {
	const hits = []
	ls.forEach((l, i) => {
		if (l.trim() === trimEq) hits.push(i)
	})
	if (hits.length === 0) throw new Error(`anchor not found: "${trimEq}"`)
	if (hits.length > 1) throw new Error(`anchor not unique (${hits.length}x): "${trimEq}"`)
	return hits[0]
}

const after = (trimEq, build) => (ls) => {
	const i = idx(ls, trimEq)
	ls.splice(i + 1, 0, ...build(indentOf(ls[i])))
	return ls
}
const before = (trimEq, build) => (ls) => {
	const i = idx(ls, trimEq)
	ls.splice(i, 0, ...build(indentOf(ls[i])))
	return ls
}
const replace = (trimEq, build) => (ls) => {
	const i = idx(ls, trimEq)
	ls[i] = build(indentOf(ls[i]))
	return ls
}

function patch(rel, steps) {
	const p = join(SRC, rel)
	let text
	try {
		text = readFileSync(p, "utf8")
	} catch {
		throw new Error(`cannot read ${p} — run this from the repo root`)
	}
	const eol = text.includes("\r\n") ? "\r\n" : "\n"
	let ls = text.split(/\r?\n/)
	for (const step of steps) {
		if (ls.some((l) => l.includes(step.marker))) {
			skipped++
			console.log(`  skip   ${rel}: ${step.name}`)
			continue
		}
		ls = step.apply(ls)
		applied++
		console.log(`  apply  ${rel}: ${step.name}`)
	}
	writeFileSync(p, ls.join(eol))
}

patch("store.ts", [
	{
		name: "Store.setOrgPlan signature",
		marker: "setOrgPlan(orgId: string, plan: string): Promise<void>",
		apply: after("getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined>", (ind) => [
			`${ind}setOrgPlan(orgId: string, plan: string): Promise<void>`,
		]),
	},
	{
		name: "MemStore.setOrgPlan impl",
		marker: "async setOrgPlan(orgId: string, plan: string)",
		apply: before("async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {", (ind) => [
			`${ind}async setOrgPlan(orgId: string, plan: string): Promise<void> {`,
			`${ind}\tconst org = this.orgs.get(orgId)`,
			`${ind}\tif (org) org.plan = plan`,
			`${ind}}`,
			``,
		]),
	},
])

patch("pgStore.ts", [
	{
		name: "PgStore.setOrgPlan impl",
		marker: "async setOrgPlan(orgId: string, plan: string)",
		apply: before("async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {", (ind) => [
			`${ind}async setOrgPlan(orgId: string, plan: string): Promise<void> {`,
			`${ind}\tawait this.pool.query("update orgs set plan=$2 where id=$1", [orgId, plan])`,
			`${ind}}`,
			``,
		]),
	},
])

patch("service.ts", [
	{
		name: "import paddle types",
		marker: `from "./paddle"`,
		apply: after(`import { toRecord, type Store } from "./store"`, (ind) => [
			`${ind}import type { PaddleBilling, CheckoutResult, WebhookResult } from "./paddle"`,
		]),
	},
	{
		name: "ServiceDeps.billing",
		marker: "billing?: PaddleBilling",
		apply: after("limiter?: UsageLimiter", (ind) => [`${ind}billing?: PaddleBilling`]),
	},
	{
		name: "field billing",
		marker: "private readonly billing?: PaddleBilling",
		apply: after("private readonly limiter?: UsageLimiter", (ind) => [
			`${ind}private readonly billing?: PaddleBilling`,
		]),
	},
	{
		name: "assign billing",
		marker: "this.billing = deps.billing",
		apply: after("this.limiter = deps.limiter", (ind) => [`${ind}this.billing = deps.billing`]),
	},
	{
		name: "billing methods",
		marker: "async handlePaddleWebhook(",
		apply: before("async usage(orgId: string): Promise<UsageSnapshot> {", (ind) => [
			`${ind}async createCheckout(`,
			`${ind}\torgId: string,`,
			`${ind}\tinput: { plan?: string },`,
			`${ind}): Promise<CheckoutResult> {`,
			`${ind}\tif (!this.billing) throw badRequest("billing is not configured")`,
			`${ind}\tconst plan = input?.plan`,
			`${ind}\tif (plan !== "pro" && plan !== "scale") {`,
			`${ind}\t\tthrow badRequest("plan must be 'pro' or 'scale'")`,
			`${ind}\t}`,
			`${ind}\treturn this.billing.createCheckout(orgId, plan)`,
			`${ind}}`,
			``,
			`${ind}async handlePaddleWebhook(`,
			`${ind}\trawBody: string,`,
			`${ind}\tsignature: string | undefined,`,
			`${ind}): Promise<WebhookResult> {`,
			`${ind}\tif (!this.billing) throw badRequest("billing is not configured")`,
			`${ind}\ttry {`,
			`${ind}\t\treturn await this.billing.handleWebhook(rawBody, signature, this.store)`,
			`${ind}\t} catch (e) {`,
			`${ind}\t\tconst msg = e instanceof Error ? e.message : "webhook error"`,
			`${ind}\t\tif (msg.includes("signature") || msg.includes("payload")) {`,
			`${ind}\t\t\tthrow authError(msg)`,
			`${ind}\t\t}`,
			`${ind}\t\tthrow e`,
			`${ind}\t}`,
			`${ind}}`,
			``,
		]),
	},
])

patch("router.ts", [
	{
		name: "RawRequest.rawBody",
		marker: "rawBody?: string",
		apply: after("headers: Record<string, string | undefined>", (ind) => [`${ind}rawBody?: string`]),
	},
	{
		name: "paddle webhook route",
		marker: `"/v1/webhooks/paddle"`,
		apply: before("// Everything else under /v1 needs a valid Bearer key.", (ind) => [
			`${ind}// Paddle webhooks authenticate by signature (raw body), not a Bearer key.`,
			`${ind}if (req.method === "POST" && req.path === "/v1/webhooks/paddle") {`,
			`${ind}\treturn {`,
			`${ind}\t\tstatus: 200,`,
			`${ind}\t\tbody: await svc.handlePaddleWebhook(`,
			`${ind}\t\t\treq.rawBody ?? "",`,
			`${ind}\t\t\treq.headers["paddle-signature"],`,
			`${ind}\t\t),`,
			`${ind}\t}`,
			`${ind}}`,
			``,
		]),
	},
	{
		name: "billing checkout route",
		marker: `"/v1/billing/checkout"`,
		apply: after(`const { orgId } = await svc.authenticate(req.headers["authorization"])`, (ind) => [
			``,
			`${ind}if (req.path === "/v1/billing/checkout" && req.method === "POST") {`,
			`${ind}\treturn { status: 200, body: await svc.createCheckout(orgId, req.body ?? {}) }`,
			`${ind}}`,
		]),
	},
])

patch("server.ts", [
	{
		name: "raw-body content-type parser",
		marker: "addContentTypeParser",
		apply: after("const app = Fastify({ logger: false })", (ind) => [
			`${ind}// Capture the raw JSON body so webhook signatures can be verified.`,
			`${ind}app.addContentTypeParser(`,
			`${ind}\t"application/json",`,
			`${ind}\t{ parseAs: "string" },`,
			`${ind}\t(req: any, body: any, done: any) => {`,
			`${ind}\t\t;(req as any).rawBody = body`,
			`${ind}\t\tif (!body) return done(null, undefined)`,
			`${ind}\t\ttry {`,
			`${ind}\t\t\tdone(null, JSON.parse(body as string))`,
			`${ind}\t\t} catch (err) {`,
			`${ind}\t\t\tdone(err as Error, undefined)`,
			`${ind}\t\t}`,
			`${ind}\t},`,
			`${ind})`,
			``,
		]),
	},
	{
		name: "pass rawBody to handleRequest",
		marker: "rawBody: (req as any).rawBody",
		apply: after("headers: req.headers ?? {},", (ind) => [`${ind}rawBody: (req as any).rawBody,`]),
	},
])

patch("wiring.ts", [
	{
		name: "import PaddleBilling",
		marker: `from "./paddle"`,
		apply: after(`} from "./billing"`, (ind) => [`${ind}import { PaddleBilling } from "./paddle"`]),
	},
	{
		name: "ServiceDepsBundle billing type",
		marker: "billing?: PaddleBilling",
		apply: replace(
			"deps: { bus: EventBus; limiter: UsageMeter }",
			(ind) => `${ind}deps: { bus: EventBus; limiter: UsageMeter; billing?: PaddleBilling }`,
		),
	},
	{
		name: "build PaddleBilling from env",
		marker: "const priceToPlan: Record<string, string>",
		apply: after("const meter = new UsageMeter(usageStore, plans, reporter)", (ind) => [
			``,
			`${ind}const priceToPlan: Record<string, string> = {}`,
			`${ind}if (env.PADDLE_PRICE_PRO) priceToPlan[env.PADDLE_PRICE_PRO] = "pro"`,
			`${ind}if (env.PADDLE_PRICE_SCALE) priceToPlan[env.PADDLE_PRICE_SCALE] = "scale"`,
			`${ind}const billing =`,
			`${ind}\tenv.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET`,
			`${ind}\t\t? new PaddleBilling({`,
			`${ind}\t\t\t\tapiKey: env.PADDLE_API_KEY,`,
			`${ind}\t\t\t\twebhookSecret: env.PADDLE_WEBHOOK_SECRET,`,
			`${ind}\t\t\t\tpriceToPlan,`,
			`${ind}\t\t\t\tapiBase: env.PADDLE_API_BASE,`,
			`${ind}\t\t\t})`,
			`${ind}\t\t: undefined`,
		]),
	},
	{
		name: "return billing in deps",
		marker: "limiter: meter, billing",
		apply: replace(
			"return { deps: { bus, limiter: meter }, bus, close }",
			(ind) => `${ind}return { deps: { bus, limiter: meter, billing }, bus, close }`,
		),
	},
])

console.log(`\nPaddle wiring: ${applied} applied, ${skipped} skipped.`)
