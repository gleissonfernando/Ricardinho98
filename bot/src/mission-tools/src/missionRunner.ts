// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { ClientQuest } from './client';
import { Quest } from './quest';

export type MissionState = 'Waiting' | 'Running' | 'Completed' | 'Error';

export type MissionStatusUpdate = {
	state: MissionState;
	currentMission?: string;
	currentIndex?: number;
	totalMissions?: number;
	queuePosition?: number;
	progress?: number;
	detail?: string;
};

export type MissionStatusReporter = (
	update: MissionStatusUpdate,
	force?: boolean,
) => void | Promise<void>;

type MissionDetails = {
	name: string;
	duration: number;
	reward: string;
};

function getQuestData(quest: Quest): MissionDetails {
	const questId = quest.id || quest.config?.id || 'unknown';
	const name =
		quest.config?.messages?.quest_name?.trim() ||
		quest.config?.messages?.game_title?.trim() ||
		questId;
	const tasks =
		quest.config?.task_config?.tasks ?? quest.config?.task_config_v2?.tasks;
	const firstTask = tasks ? Object.values(tasks)[0] : undefined;
	const duration = firstTask?.target ?? 0;
	const rewardConfig = quest.config?.rewards_config?.rewards?.[0];
	const reward =
		rewardConfig?.messages?.name ??
		(rewardConfig?.orb_quantity
			? `${rewardConfig.orb_quantity} Orbs`
			: 'Unknown reward');

	return { name, duration, reward };
}

function toProgress(secondsDone?: number, secondsNeeded?: number): number {
	if (!secondsNeeded || secondsNeeded <= 0) return 0;
	return Math.min(
		100,
		Math.max(0, Math.round(((secondsDone ?? 0) / secondsNeeded) * 100)),
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return Boolean(signal?.aborted) || error === signal?.reason;
}

function averageProgress(progress: number[]): number {
	if (progress.length === 0) return 0;
	const total = progress.reduce((sum, value) => sum + value, 0);
	return Math.round(total / progress.length);
}

function normalizeConcurrency(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.min(25, Math.floor(value)));
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex++;
			await worker(items[index], index);
		}
	});

	await Promise.all(workers);
}

export async function runMissionFlow(
	token: string,
	reportStatus: MissionStatusReporter,
	signal?: AbortSignal,
	concurrency = 1,
): Promise<void> {
	signal?.throwIfAborted();
	await reportStatus({
		state: 'Waiting',
		detail: 'Buscando missoes disponiveis.',
	});

	const questClient = new ClientQuest(token);
	const manager = await questClient.fetchQuests();
	signal?.throwIfAborted();
	const quests = manager.filterQuestsValid();

	if (quests.length === 0) {
		await reportStatus(
			{
				state: 'Completed',
				progress: 100,
				detail: 'Nenhuma missao valida foi encontrada.',
				totalMissions: 0,
			},
			true,
		);
		return;
	}

	let completed = 0;
	let failed = 0;
	const missionProgress = quests.map(() => 0);
	const missionConcurrency = normalizeConcurrency(concurrency);

	await runWithConcurrency(quests, missionConcurrency, async (quest, index) => {
		signal?.throwIfAborted();
		const details = getQuestData(quest);
		const currentIndex = index + 1;

		await reportStatus({
			state: 'Running',
			currentMission: `${Math.min(
				missionConcurrency,
				quests.length,
			)} missoes em andamento.`,
			currentIndex,
			totalMissions: quests.length,
			progress: 0,
			detail: `${details.name} | Recompensa: ${details.reward}`,
		});

		try {
			await manager.doingQuest(quest, (update) => {
				if (signal?.aborted) return;
				missionProgress[index] = toProgress(
					update.secondsDone,
					update.secondsNeeded,
				);
				void reportStatus({
					state: 'Running',
					currentMission: details.name,
					currentIndex: completed,
					totalMissions: quests.length,
					progress: averageProgress(missionProgress),
					detail: update.message,
				});
			}, signal);
			signal?.throwIfAborted();
			completed++;
			missionProgress[index] = 100;
			await reportStatus(
				{
					state: 'Completed',
					currentMission: details.name,
					currentIndex: completed,
					totalMissions: quests.length,
					progress: averageProgress(missionProgress),
					detail: `Concluidas ${completed} de ${quests.length} missoes.`,
				},
				true,
			);
		} catch (error) {
			if (isAbortError(error, signal)) {
				throw error;
			}

			failed++;
			await reportStatus(
				{
					state: 'Running',
					currentMission: details.name,
					currentIndex: completed,
					totalMissions: quests.length,
					progress: averageProgress(missionProgress),
					detail: errorMessage(error),
				},
				true,
			);
		}
	});

	await reportStatus(
		{
			state: failed > 0 ? 'Error' : 'Completed',
			progress: 100,
			totalMissions: quests.length,
			currentIndex: completed,
			detail:
				failed > 0
					? `Finalizado com ${completed} concluidas e ${failed} com erro.`
					: `Todas as ${completed} missoes foram concluidas.`,
		},
		true,
	);
}
