// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CheckerOptions, CheckerStats } from './user';

export type PanelSystemStatus =
	| 'active'
	| 'inactive'
	| 'deactivated'
	| 'waiting'
	| 'running'
	| 'completed'
	| 'error';

export type VoiceSessionStatus =
	| 'connected'
	| 'disconnected'
	| 'reconnecting';

export type RichPresenceStatus = 'active' | 'inactive';

export type RichPresenceActivityType = 0 | 1 | 2 | 3 | 5;

export type ClearCleanupMode = 'bulk' | 'userDm';

export type RichPresenceConfig = {
	applicationId?: string;
	activityType?: RichPresenceActivityType;
	name?: string;
	description?: string;
	state?: string;
	details?: string;
	buttonLabel?: string;
	buttonUrl?: string;
	largeImage?: string;
	largeText?: string;
	smallImage?: string;
	smallText?: string;
	startTimestamp?: string;
};

export type UsernameCheckerPanelOptions = Pick<
	CheckerOptions,
	'usernameLength' | 'concurrency' | 'requestDelay'
>;

export type MainPanelRecord = {
	userId?: string;
	channelId?: string;
	messageId?: string;
	updatedAt: string;
};

export type UserPanelRecord = {
	userId: string;
	dmChannelId?: string;
	clearMessageId?: string;
	missionMessageId?: string;
	voiceMessageId?: string;
	richPresenceMessageId?: string;
	usernameCheckerMessageId?: string;
	tokenConfigured: boolean;
	clearStatus: PanelSystemStatus;
	clearMode: ClearCleanupMode;
	clearTargetUserId?: string;
	missionStatus: PanelSystemStatus;
	missionConcurrency: number;
	voiceStatus: VoiceSessionStatus;
	richPresenceStatus: RichPresenceStatus;
	usernameCheckerStatus: PanelSystemStatus;
	currentMission?: string;
	voiceGuildId?: string;
	voiceGuildName?: string;
	voiceChannelId?: string;
	voiceChannelName?: string;
	voiceConnectedAt?: string;
	richPresenceConfig: RichPresenceConfig;
	richPresenceUpdatedAt?: string;
	usernameCheckerOptions: UsernameCheckerPanelOptions;
	usernameCheckerStats: CheckerStats;
	usernameCheckerLastEvent?: string;
	usernameCheckerUpdatedAt?: string;
	completedCount: number;
	totalMissions: number;
	progress: number;
	updatedAt: string;
};

type PanelStoreFile = {
	version: 2;
	mainPanel: MainPanelRecord;
	users: Record<string, UserPanelRecord>;
};

type LegacyPanelStoreFile = {
	version?: number;
	users?: Record<string, Partial<UserPanelRecord> & {
		channelId?: string;
		messageId?: string;
		status?: PanelSystemStatus;
	}>;
};

const DEFAULT_STORE_PATH = path.join('data', 'mission-panels.json');
const STORE_VERSION = 2;
const DEFAULT_USERNAME_CHECKER_OPTIONS: UsernameCheckerPanelOptions = {
	usernameLength: 4,
	requestDelay: 2000,
};
const DEFAULT_USERNAME_CHECKER_STATS: CheckerStats = {
	hits: 0,
	taken: 0,
	errors: 0,
	deadProxies: 0,
	activeProxies: 0,
	bannedProxies: 0,
	workersRunning: 0,
};
const DEFAULT_MISSION_CONCURRENCY = 5;

function normalizeMissionConcurrency(value: unknown): number {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string'
				? Number.parseInt(value, 10)
				: DEFAULT_MISSION_CONCURRENCY;

	if (!Number.isFinite(parsed)) return DEFAULT_MISSION_CONCURRENCY;
	return Math.max(1, Math.min(25, Math.floor(parsed)));
}

export class PanelStore {
	private readonly filePath: string;
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(filePath = process.env.PANEL_STORE_PATH ?? DEFAULT_STORE_PATH) {
		this.filePath = path.resolve(process.cwd(), filePath);
	}

	async getMainPanel(): Promise<MainPanelRecord> {
		return this.withLock(async () => {
			const store = await this.read();
			return store.mainPanel;
		});
	}

	async saveMainPanel(
		patch: Partial<Omit<MainPanelRecord, 'updatedAt'>>,
	): Promise<MainPanelRecord> {
		return this.withLock(async () => {
			const store = await this.read();
			const next: MainPanelRecord = {
				...store.mainPanel,
				...patch,
				updatedAt: new Date().toISOString(),
			};
			store.mainPanel = next;
			await this.write(store);
			return next;
		});
	}

	async getUser(userId: string): Promise<UserPanelRecord> {
		return this.withLock(async () => {
			const store = await this.read();
			return store.users[userId] ?? this.defaultUserRecord(userId);
		});
	}

	async hasUser(userId: string): Promise<boolean> {
		return this.withLock(async () => {
			const store = await this.read();
			return Boolean(store.users[userId]);
		});
	}

	async updateUser(
		userId: string,
		patch: Partial<Omit<UserPanelRecord, 'userId'>>,
	): Promise<UserPanelRecord> {
		return this.withLock(async () => {
			const store = await this.read();
			const current = store.users[userId] ?? this.defaultUserRecord(userId);
			const next: UserPanelRecord = {
				...current,
				...patch,
				userId,
				updatedAt: new Date().toISOString(),
			};
			store.users[userId] = next;
			await this.write(store);
			return next;
		});
	}

	private defaultUserRecord(userId: string): UserPanelRecord {
		return {
			userId,
			tokenConfigured: false,
			clearStatus: 'deactivated',
			clearMode: 'bulk',
			missionStatus: 'inactive',
			missionConcurrency: DEFAULT_MISSION_CONCURRENCY,
			voiceStatus: 'disconnected',
			richPresenceStatus: 'inactive',
			usernameCheckerStatus: 'inactive',
			richPresenceConfig: {},
			usernameCheckerOptions: { ...DEFAULT_USERNAME_CHECKER_OPTIONS },
			usernameCheckerStats: { ...DEFAULT_USERNAME_CHECKER_STATS },
			completedCount: 0,
			totalMissions: 0,
			progress: 0,
			updatedAt: new Date().toISOString(),
		};
	}

	private defaultMainPanel(): MainPanelRecord {
		return {
			updatedAt: new Date().toISOString(),
		};
	}

	private async read(): Promise<PanelStoreFile> {
		try {
			const raw = await fs.readFile(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as PanelStoreFile | LegacyPanelStoreFile;
			return this.normalizeStore(parsed);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return this.emptyStore();
			if (error instanceof SyntaxError) {
				await this.backupCorruptFile();
				return this.emptyStore();
			}
			throw error;
		}
	}

	private normalizeStore(
		store: PanelStoreFile | LegacyPanelStoreFile,
	): PanelStoreFile {
		if (store.version === STORE_VERSION && 'mainPanel' in store) {
			const users = Object.fromEntries(
				Object.entries(store.users ?? {}).map(([userId, record]) => [
					userId,
					this.normalizeUser(userId, record),
				]),
			);

			return {
				version: STORE_VERSION,
				mainPanel: store.mainPanel ?? this.defaultMainPanel(),
				users,
			};
		}

		const legacyUsers = store.users ?? {};
		const firstLegacyPanel = Object.values(legacyUsers).find(
			(record) => record.channelId && record.messageId,
		);

		return {
			version: STORE_VERSION,
			mainPanel: firstLegacyPanel
				? {
					channelId: firstLegacyPanel.channelId,
					messageId: firstLegacyPanel.messageId,
					updatedAt:
						firstLegacyPanel.updatedAt ?? new Date().toISOString(),
				}
				: this.defaultMainPanel(),
			users: Object.fromEntries(
				Object.entries(legacyUsers).map(([userId, record]) => [
					userId,
					this.normalizeUser(userId, {
						...record,
						missionStatus: record.status,
						dmChannelId: undefined,
						clearMessageId: undefined,
						missionMessageId: undefined,
						voiceMessageId: undefined,
						richPresenceMessageId: undefined,
						usernameCheckerMessageId: undefined,
					}),
				]),
			),
		};
	}

	private normalizeUser(
		userId: string,
		record: Partial<UserPanelRecord>,
	): UserPanelRecord {
		const defaults = this.defaultUserRecord(userId);

		return {
			...defaults,
			...record,
			userId,
			tokenConfigured: Boolean(record.tokenConfigured),
			clearStatus: record.clearStatus ?? defaults.clearStatus,
			clearMode: record.clearMode ?? defaults.clearMode,
			clearTargetUserId: record.clearTargetUserId,
			missionStatus: record.missionStatus ?? defaults.missionStatus,
			missionConcurrency: normalizeMissionConcurrency(
				record.missionConcurrency,
			),
			voiceStatus: record.voiceStatus ?? defaults.voiceStatus,
			richPresenceStatus:
				record.richPresenceStatus ?? defaults.richPresenceStatus,
			usernameCheckerStatus:
				record.usernameCheckerStatus ?? defaults.usernameCheckerStatus,
			richPresenceConfig:
				record.richPresenceConfig ?? defaults.richPresenceConfig,
			usernameCheckerOptions: {
				...defaults.usernameCheckerOptions,
				...record.usernameCheckerOptions,
			},
			usernameCheckerStats: {
				...defaults.usernameCheckerStats,
				...record.usernameCheckerStats,
			},
			completedCount: record.completedCount ?? defaults.completedCount,
			totalMissions: record.totalMissions ?? defaults.totalMissions,
			progress: record.progress ?? defaults.progress,
			updatedAt: record.updatedAt ?? defaults.updatedAt,
		};
	}

	private async write(store: PanelStoreFile): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		await fs.writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8');
		await fs.rename(tempPath, this.filePath);
	}

	private emptyStore(): PanelStoreFile {
		return {
			version: STORE_VERSION,
			mainPanel: this.defaultMainPanel(),
			users: {},
		};
	}

	private async backupCorruptFile(): Promise<void> {
		const backupPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
		try {
			await fs.rename(this.filePath, backupPath);
			console.error(
				`Panel store JSON was invalid. Backed it up to ${backupPath}.`,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT') throw error;
		}
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.operationQueue;
		let release!: () => void;
		this.operationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});

		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
