// Thin Fastify adapter. It only translates HTTP <-> RawRequest/RawResponse and
// delegates ALL logic to handleRequest (router.ts), so what we unit-test is what
// serves traffic. Typed loosely so it compiles against the sandbox mock and the
// real `fastify` types identically.
import Fastify from "fastify"
import { handleRequest } from "./router"
import { QuorvelCloudService, type ServiceDeps } from "./service"
import type { Store } from "./store"

export interface ServerOptions {
	adminSecret?: string
	deps?: ServiceDeps
}

export function buildServer(store: Store, opts: ServerOptions = {}) {
	const app = Fastify({ logger: false })
	// Capture the raw JSON body so webhook signatures can be verified.
	app.addContentTypeParser(
		"application/json",
		{ parseAs: "string" },
		(req: any, body: any, done: any) => {
			;(req as any).rawBody = body
			if (!body) return done(null, undefined)
			try {
				done(null, JSON.parse(body as string))
			} catch (err) {
				done(err as Error, undefined)
			}
		},
	)

	const svc = new QuorvelCloudService(store, opts.deps)
	const adminSecret = opts.adminSecret ?? process.env.QUORVEL_ADMIN_SECRET

	app.all("/*", async (req: any, reply: any) => {
		const url: string = req.url ?? "/"
		const path = url.split("?")[0]
		const res = await handleRequest(svc, adminSecret, {
			method: req.method,
			path,
			query: req.query ?? {},
			body: req.body,
			headers: req.headers ?? {},
			rawBody: (req as any).rawBody,
		})
		reply.code(res.status)
		return res.body ?? null
	})

	return app
}
