// Thin Fastify adapter. It only translates HTTP <-> RawRequest/RawResponse and
// delegates ALL logic to handleRequest (router.ts), so what we unit-test is what
// serves traffic. Typed loosely so it compiles against the sandbox mock and the
// real `fastify` types identically.
import Fastify from "fastify"
import { handleRequest } from "./router"
import { BelayCloudService, type ServiceDeps } from "./service"
import type { Store } from "./store"

export interface ServerOptions {
	adminSecret?: string
	deps?: ServiceDeps
}

export function buildServer(store: Store, opts: ServerOptions = {}) {
	const app = Fastify({ logger: false })
	const svc = new BelayCloudService(store, opts.deps)
	const adminSecret = opts.adminSecret ?? process.env.BELAY_ADMIN_SECRET

	app.all("/*", async (req: any, reply: any) => {
		const url: string = req.url ?? "/"
		const path = url.split("?")[0]
		const res = await handleRequest(svc, adminSecret, {
			method: req.method,
			path,
			query: req.query ?? {},
			body: req.body,
			headers: req.headers ?? {},
		})
		reply.code(res.status)
		return res.body ?? null
	})

	return app
}
