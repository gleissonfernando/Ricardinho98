// Credito: Perfil Discord https://discord.com/users/1411202571804348507
export type MissionJob = {
	userId: string;
	run: (signal: AbortSignal) => Promise<void>;
	onQueued: (position: number) => void | Promise<void>;
	onRejected: (reason: string) => void | Promise<void>;
	onCancelled?: (reason: string) => void | Promise<void>;
	onFailed?: (reason: string) => void | Promise<void>;
	controller?: AbortController;
};

export class MissionQueue {
	private queue: MissionJob[] = [];
	private running: MissionJob[] = [];

	constructor(private readonly maxConcurrent = 1) {}

	enqueue(job: MissionJob): boolean {
		if (this.hasJobForUser(job.userId)) {
			void job.onRejected(
				'Voce ja tem uma operacao na fila ou em andamento.',
			);
			return false;
		}

		this.queue.push(job);
		this.runCallback(
			job.onQueued,
			this.running.length < this.maxConcurrent ? 1 : this.queue.length,
		);
		this.scheduleDrain();
		return true;
	}

	cancelUser(userId: string, reason: string): boolean {
		const runningJob = this.running.find((job) => job.userId === userId);
		if (runningJob) {
			runningJob.controller?.abort(reason);
			if (runningJob.onCancelled) {
				this.runCallback(runningJob.onCancelled, reason);
			}
			return true;
		}

		const queuedIndex = this.queue.findIndex((job) => job.userId === userId);
		if (queuedIndex === -1) return false;

		const [job] = this.queue.splice(queuedIndex, 1);
		if (job.onCancelled) {
			this.runCallback(job.onCancelled, reason);
		}
		return true;
	}

	private hasJobForUser(userId: string): boolean {
		return (
			this.running.some((job) => job.userId === userId) ||
			this.queue.some((job) => job.userId === userId)
		);
	}

	private async drain(): Promise<void> {
		while (this.running.length < this.maxConcurrent) {
			const job = this.queue.shift();
			if (!job) return;

			this.startJob(job);
		}
	}

	private startJob(job: MissionJob): void {
		this.running.push(job);
		job.controller = new AbortController();
		void this.executeJob(job).catch((error: unknown) => {
			console.error('Mission queue job failed:', error);
		});
	}

	private async executeJob(job: MissionJob): Promise<void> {
		try {
			await job.run(job.controller?.signal ?? new AbortController().signal);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			await (job.onFailed ?? job.onRejected)(reason);
		} finally {
			this.running = this.running.filter((runningJob) => runningJob !== job);
			this.scheduleDrain();
		}
	}

	private scheduleDrain(): void {
		void this.drain().catch((error: unknown) => {
			console.error('Mission queue drain failed:', error);
		});
	}

	private runCallback<T>(
		callback: (value: T) => void | Promise<void>,
		value: T,
	): void {
		void Promise.resolve(callback(value)).catch((error: unknown) => {
			console.error('Mission queue callback failed:', error);
		});
	}
}
