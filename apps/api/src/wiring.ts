// Assembles the runtime dependencies from env: usage store (PG or memory),
// plan lookup, optional Stripe reporter, alert transports, and an event bus
// (BullMQ/Redis when REDIS_URL is set, otherwise in-process). All gated by
// which env vars are present.
import type { Store } from "./store"
import type { EventBus, Subscriber } from "./bus"
import { InProcessBus, QueueBus } from "./bus"
import { createQueue } from "./queue"
import type { DomainEvent } from "./events"
import {
	AlertDispatcher,
	EmailTransport,
	SlackTransport,
	WebhookTransport,
	type AlertTransport,
} from "./alerts"
import {
	MemUsageStore,
	PgUsageStore,
	StripeMeter,
	UsageMeter,
	type PlanLookup,
	type SqlPool,
	type UsageReporter,
	type UsageStore,
} from "./billing"
import { PaddleBilling } from "./paddle"

export interface ServiceDepsBundle {
	deps: { bus: EventBus; limiter: UsageMeter; billing?: PaddleBilling }
	bus: EventBus
	close(): Promise<void>
}

export function buildDeps(
	store: Store,
	opts: { pool?: SqlPool; env?: Record<string, string | undefined> } = {},
): ServiceDepsBundle {
	const env = opts.env ?? process.env

	const usageStore: UsageStore = opts.pool
		? new PgUsageStore(opts.pool)
		: new MemUsageStore()
	const plans: PlanLookup = async (orgId) =>
		(await store.getOrg(orgId))?.plan ?? "free"
	const reporter: UsageReporter | undefined = env.STRIPE_SECRET_KEY
		? new StripeMeter({ secretKey: env.STRIPE_SECRET_KEY })
		: undefined
	const meter = new UsageMeter(usageStore, plans, reporter)

	const priceToPlan: Record<string, string> = {}
	if (env.PADDLE_PRICE_PRO) priceToPlan[env.PADDLE_PRICE_PRO] = "pro"
	if (env.PADDLE_PRICE_SCALE) priceToPlan[env.PADDLE_PRICE_SCALE] = "scale"
	const billing =
		env.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET
			? new PaddleBilling({
					apiKey: env.PADDLE_API_KEY,
					webhookSecret: env.PADDLE_WEBHOOK_SECRET,
					priceToPlan,
					apiBase: env.PADDLE_API_BASE,
				})
			: undefined

	const transports: AlertTransport[] = []
	if (env.SLACK_WEBHOOK_URL) transports.push(new SlackTransport(env.SLACK_WEBHOOK_URL))
	if (env.ALERT_WEBHOOK_URL) transports.push(new WebhookTransport(env.ALERT_WEBHOOK_URL))
	if (env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO) {
		transports.push(
			new EmailTransport({
				apiKey: env.RESEND_API_KEY,
				from: env.ALERT_EMAIL_FROM,
				to: env.ALERT_EMAIL_TO,
			}),
		)
	}
	const dispatcher = new AlertDispatcher(transports)

	const subscribers: Subscriber[] = [meter.onEvent, dispatcher.handle]

	let close: () => Promise<void> = async () => {}
	let bus: EventBus
	if (env.REDIS_URL) {
		const queue = createQueue<DomainEvent>({
			redisUrl: env.REDIS_URL,
			queueName: env.QUORVEL_QUEUE_NAME,
		})
		bus = new QueueBus(queue, subscribers)
		close = async () => {
			await queue.close()
		}
	} else {
		bus = new InProcessBus(subscribers)
	}

	return { deps: { bus, limiter: meter, billing }, bus, close }
}
