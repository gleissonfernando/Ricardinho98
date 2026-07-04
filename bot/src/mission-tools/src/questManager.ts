// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { ClientQuest } from './client';
import type {
	AllQuestsResponse,
	QuestTask,
} from './interface';
import { QuestTaskConfigType } from './interface';
import { Quest } from './quest';

export type QuestProgressUpdate = {
	message: string;
	secondsDone?: number;
	secondsNeeded?: number;
};

export type QuestProgressReporter = (update: QuestProgressUpdate) => void;

const SUPPORTED_TASKS = [
	QuestTaskConfigType.WATCH_VIDEO,
	QuestTaskConfigType.PLAY_ON_DESKTOP,
	QuestTaskConfigType.STREAM_ON_DESKTOP,
	QuestTaskConfigType.PLAY_ACTIVITY,
	QuestTaskConfigType.WATCH_VIDEO_ON_MOBILE,
] as const;

function getSupportedTask(
	tasks?: Partial<Record<QuestTaskConfigType, QuestTask>>,
): { taskName: QuestTaskConfigType; task: QuestTask } | null {
	if (!tasks) return null;

	for (const taskName of SUPPORTED_TASKS) {
		const task = tasks[taskName];
		if (task) {
			return { taskName, task };
		}
	}

	return null;
}

export class QuestManager implements Iterable<Quest> {
	private readonly quests = new Map<string, Quest>();
	public readonly client: ClientQuest;
	constructor(client: ClientQuest, quests: Quest[] = []) {
		this.client = client;
		quests.forEach((quest) => this.quests.set(quest.id, quest));
	}

	static fromResponse(
		client: ClientQuest,
		response: AllQuestsResponse,
	): QuestManager {
		if (!Array.isArray(response?.quests)) {
			throw new Error(
				'Discord did not return a quest list. Check your token and try again.',
			);
		}

		return new QuestManager(
			client,
			response.quests.map((quest) => Quest.create(quest)),
		);
	}

	[Symbol.iterator](): IterableIterator<Quest> {
		return this.quests.values();
	}

	get size(): number {
		return this.quests.size;
	}

	list(): Quest[] {
		return Array.from(this.quests.values());
	}

	get(id: string): Quest | undefined {
		return this.quests.get(id);
	}

	upsert(quest: Quest): void {
		this.quests.set(quest.id, quest);
	}

	remove(id: string): boolean {
		return this.quests.delete(id);
	}

	clear(): void {
		this.quests.clear();
	}

	getExpired(date: Date = new Date()): Quest[] {
		return this.list().filter((quest) => quest.isExpired(date));
	}

	getCompleted(): Quest[] {
		return this.list().filter((quest) => quest.isCompleted());
	}

	getClaimable(): Quest[] {
		return this.list().filter(
			(quest) => quest.isCompleted() && !quest.hasClaimedRewards(),
		);
	}

	hasQuest(id: string): boolean {
		return this.quests.has(id);
	}

	filterQuestsValid() {
		return this.list().filter(
			(quest) =>
				quest.id !== '1412491570820812933' &&
				!quest.isCompleted() &&
				!quest.isExpired(),
		);
	}

	getApplicationData(ids: string[]) {
		const query = new URLSearchParams();
		ids.forEach((id) => query.append('application_ids', id));
		return this.client.rest.get(`/applications/public`, {
			query,
		}) as Promise<
			{
				// Partial<ApplicationData>
				id: string;
				name: string;
				icon: string;
				description: string;
				executables: {
					os: string;
					name: string;
					is_launcher: boolean;
				}[];
			}[]
		>;
	}

	acceptQuest(questId: string, signal?: AbortSignal) {
		return this.withAbort(this.client.rest
			.post(`/quests/${questId}/enroll`, {
				body: {
					location: 11, // QUEST_HOME_DESKTOP | https://docs.discord.food/resources/quests#quest-content-type
					is_targeted: false,
					metadata_raw: null,
				},
			})
			.then((r) => {
				const quest = this.get(questId);
				quest?.updateUserStatus(r as any);
				return quest;
			}), signal);
	}

	private abortError(signal?: AbortSignal): Error {
		const reason = signal?.reason;
		if (reason instanceof Error) return reason;

		return new Error(
			typeof reason === 'string' && reason
				? reason
				: 'Operacao cancelada.',
		);
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw this.abortError(signal);
		}
	}

	private async withAbort<T>(
		promise: Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		this.throwIfAborted(signal);
		if (!signal) return promise;

		return new Promise<T>((resolve, reject) => {
			const onAbort = () => reject(this.abortError(signal));
			signal.addEventListener('abort', onAbort, { once: true });

			promise.then(
				(value) => {
					signal.removeEventListener('abort', onAbort);
					if (signal.aborted) {
						reject(this.abortError(signal));
						return;
					}
					resolve(value);
				},
				(error) => {
					signal.removeEventListener('abort', onAbort);
					reject(error);
				},
			);
		});
	}

	private async timeout(ms: number, signal?: AbortSignal) {
		this.throwIfAborted(signal);

		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(resolve, ms);
			signal?.addEventListener(
				'abort',
				() => {
					clearTimeout(timeoutId);
					reject(this.abortError(signal));
				},
				{ once: true },
			);
		});
	}

	async doingQuest(
		quest: Quest,
		reportProgress?: QuestProgressReporter,
		signal?: AbortSignal,
	) {
		this.throwIfAborted(signal);
		const questName = quest.config.messages?.quest_name?.trim() || quest.id;
		if (!quest.isEnrolledQuest()) {
			const message = `Entrando na missao "${questName}"...`;
			console.log(message);
			reportProgress?.({ message });
			await this.acceptQuest(quest.id, signal);
		}
		const applicationName = quest.config.application?.name ?? 'Unknown app';
		const taskConfig =
			quest.config.task_config ?? quest.config.task_config_v2;
		const supportedTask = getSupportedTask(taskConfig?.tasks);
		if (!supportedTask) {
			const availableTasks = Object.keys(taskConfig?.tasks ?? {});
			throw new Error(
				`Quest "${questName}" has no supported task type${
					availableTasks.length
						? ` (${availableTasks.join(', ')})`
						: ''
				}.`,
			);
		}

		const { taskName, task } = supportedTask;
		const secondsNeeded = task.target;
		if (!Number.isFinite(secondsNeeded) || secondsNeeded <= 0) {
			throw new Error(
				`Quest "${questName}" has an invalid target time.`,
			);
		}
		let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;
		reportProgress?.({
			message: `Iniciando ${questName}.`,
			secondsDone,
			secondsNeeded,
		});
		if (
			taskName === 'WATCH_VIDEO' ||
			taskName === 'WATCH_VIDEO_ON_MOBILE'
		) {
			const maxFuture = 10,
				speed = 7,
				interval = 1;
			const enrolledAtValue = new Date(
				quest.userStatus?.enrolled_at as any,
			).getTime();
			const enrolledAt = Number.isFinite(enrolledAtValue)
				? enrolledAtValue
				: Date.now();
			let completed = false;
			let fn = async () => {
				while (true) {
					this.throwIfAborted(signal);
					const maxAllowed =
						Math.floor((Date.now() - enrolledAt) / 1000) +
						maxFuture;
					const diff = maxAllowed - secondsDone;
					const timestamp = secondsDone + speed;
					if (diff >= speed) {
						const res = (await this.withAbort(this.client.rest.post(
							`/quests/${quest.id}/video-progress`,
							{
								body: {
									timestamp: Math.min(
										secondsNeeded,
										timestamp + Math.random(),
									),
								},
							},
						), signal)) as any;
						this.throwIfAborted(signal);
						completed = res.completed_at != null;
						secondsDone = Math.min(secondsNeeded, timestamp);
						reportProgress?.({
							message: `Progresso de video para ${questName}.`,
							secondsDone,
							secondsNeeded,
						});
					}

					if (timestamp >= secondsNeeded) {
						break;
					}
					await this.timeout(interval * 1000, signal);
				}
				this.throwIfAborted(signal);
				if (!completed) {
					await this.withAbort(this.client.rest.post(
						`/quests/${quest.id}/video-progress`,
						{
							body: { timestamp: secondsNeeded },
						},
					), signal);
				}
				console.log(`Quest "${questName}" completed!`);
				reportProgress?.({
					message: `Missao "${questName}" concluida.`,
					secondsDone: secondsNeeded,
					secondsNeeded,
				});
			};
			console.log(`Spoofing video for ${questName}.`);
			await fn();
		} else if (taskName === 'PLAY_ON_DESKTOP') {
			const applicationId = quest.config.application?.id;
			if (!applicationId) {
				throw new Error(
					`Quest "${questName}" is missing an application id.`,
				);
			}
			const interval = 60;
			while (!quest.isCompleted()) {
				this.throwIfAborted(signal);
				const secondsDone =
					(quest.userStatus?.progress?.[taskName]?.value as number) ||
					0;
				const res = await this.withAbort(this.client.rest.post(
					`/quests/${quest.id}/heartbeat`,
					{
						body: {
							application_id: applicationId,
							terminal: false,
						},
					},
				), signal);
				this.throwIfAborted(signal);
				quest.updateUserStatus(res as any);
				const currentSecondsDone =
					quest.userStatus?.progress?.[taskName]?.value ??
					secondsDone;
				reportProgress?.({
					message: `Atualizando progresso de ${applicationName}.`,
					secondsDone: currentSecondsDone,
					secondsNeeded,
				});
				console.log(
					`Spoofed your game to ${applicationName}. Wait for ${Math.ceil(
						(secondsNeeded - secondsDone) / 60,
					)} more minutes.`,
				);
				await this.timeout(interval * 1000, signal);
			}
			this.throwIfAborted(signal);
			const res = await this.withAbort(this.client.rest.post(
				`/quests/${quest.id}/heartbeat`,
				{
					body: {
						application_id: applicationId,
						terminal: true,
					},
				},
			), signal);
			quest.updateUserStatus(res as any);
			console.log(`Quest "${questName}" completed!`);
			reportProgress?.({
				message: `Missao "${questName}" concluida.`,
				secondsDone: secondsNeeded,
				secondsNeeded,
			});
		} else if (taskName === 'STREAM_ON_DESKTOP') {
			throw new Error(
				`This no longer works in node for non-video quests. Use the Discord desktop app to complete the ${questName} quest.`,
			);
		} else if (taskName === 'PLAY_ACTIVITY') {
			throw new Error(
				`This quest is not supported. Use the Discord desktop app to complete the ${questName} quest.`,
			);
		} else {
			throw new Error(
				`Unknown quest type. Use the Discord desktop app to complete the ${questName} quest.`,
			);
		}
	}


}
