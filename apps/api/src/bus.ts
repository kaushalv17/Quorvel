// Event bus. InProcessBus delivers synchronously (default / no Redis); QueueBus
// pushes through a JobQueue so delivery is retried and decoupled. Same publish()
// contract either way — the wiring picks one based on env.
import type { DomainEvent } from "./events"
import type { JobQueue } from "./queue"

export type Subscriber = (e: DomainEvent) => Promise<void>

export interface EventBus {
	publish(e: DomainEvent): Promise<void>
}

export class InProcessBus implements EventBus {
	constructor(private readonly subscribers: Subscriber[]) {}

	async publish(e: DomainEvent): Promise<void> {
		for (const s of this.subscribers) await s(e)
	}
}

export class QueueBus implements EventBus {
	private started = false

	constructor(
		private readonly queue: JobQueue<DomainEvent>,
		private readonly subscribers: Subscriber[],
	) {}

	private ensureStarted(): void {
		if (this.started) return
		this.started = true
		this.queue.process(async (e) => {
			for (const s of this.subscribers) await s(e)
		})
	}

	async publish(e: DomainEvent): Promise<void> {
		this.ensureStarted()
		await this.queue.enqueue(e)
	}
}
