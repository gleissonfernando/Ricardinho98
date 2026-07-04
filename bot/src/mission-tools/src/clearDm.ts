// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { Constants } from './constants';

const API_BASE_URL = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?encoding=json&v=10';
const DEFAULT_DELETE_DELAY_MS = 700;
const MESSAGE_FETCH_LIMIT = 100;
const MESSAGE_FETCH_DELAY_MS = 75;
const FRIENDSHIP_DELETE_DELAY_MS = 100;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;

type HttpMethod = 'GET' | 'DELETE' | 'POST';

type JsonResponse<T> = {
	status: number;
	body: T | null;
};

type DiscordUser = {
	id: string;
};

type Message = {
	id: string;
	channel_id: string;
	author: {
		id: string;
	};
};

type DmChannel = {
	id: string;
	type: number;
	user_id?: string;
	owner_id?: string;
	recipient_ids?: string[];
};

type Relationship = {
	user_id: string;
};

type ReadyData = {
	relationships: Relationship[];
	private_channels: DmChannel[];
};

type GatewayPayload<T = unknown> = {
	op: number;
	t?: string;
	d: T;
};

type GatewayHello = {
	heartbeat_interval: number;
};

type RateLimitResponse = {
	retry_after?: number;
};

export type DiscordCleanupOptions = {
	token: string;
	targetUserId?: string;
	whitelistedUsers?: string[];
	whitelistedFriendships?: string[];
	baseDeleteDelayMs?: number;
	verbose?: boolean;
	signal?: AbortSignal;
};

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;

	return new Error(
		typeof reason === 'string' && reason
			? reason
			: 'Operacao cancelada.',
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);

	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timeoutId);
				reject(abortError(signal));
			},
			{ once: true },
		);
	});
}

function parseList(value?: string): string[] {
	if (!value) return [];

	return value
		.split(/[,\s]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function readDelayFromEnv(): number {
	const rawDelay = process.env.BASE_DELETE_DELAY_MS?.trim();
	const delay = rawDelay ? Number(rawDelay) : DEFAULT_DELETE_DELAY_MS;
	return Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_DELETE_DELAY_MS;
}

function readVerboseFromEnv(): boolean {
	return process.env.DISCORD_CLEANUP_VERBOSE?.trim().toLowerCase() === 'true';
}

function discordHeaders(token: string): Record<string, string> {
	return {
		'User-Agent': Constants.USER_AGENT,
		'Accept-Language': 'en-US',
		Authorization: token,
		Host: 'discord.com',
		'Content-Type': 'application/json',
		origin: 'https://discord.com',
		referer: 'https://discord.com/channels/@me',
		'x-debug-options': 'bugReporterEnabled',
		'x-discord-locale': 'en-US',
		'x-discord-timezone': 'America/Sao_Paulo',
		'x-super-properties': Buffer.from(
			JSON.stringify(Constants.Properties),
		).toString('base64'),
	};
}

function fetchDiscordJson<T>(
	token: string,
	path: string,
	method: HttpMethod = 'GET',
	expectBody = true,
): Promise<JsonResponse<T>> {
	return new Promise((resolve, reject) => {
		const url = new URL(`${API_BASE_URL}${path}`);
		const options: RequestOptions = {
			hostname: url.hostname,
			path: `${url.pathname}${url.search}`,
			method,
			headers: discordHeaders(token),
		};

		const req = request(options, (res) => {
			let data = '';

			res.on('data', (chunk: Buffer) => {
				data += chunk.toString('utf8');
			});
			res.on('end', () => {
				const status = res.statusCode ?? 0;

				try {
					const body =
						expectBody && data.length > 0
							? (JSON.parse(data) as T)
							: null;
					resolve({ status, body });
				} catch {
					resolve({ status, body: null });
				}
			});
		});

		req.on('error', reject);
		req.setTimeout(DEFAULT_HTTP_TIMEOUT_MS, () => {
			req.destroy(
				new Error(`Discord request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms.`),
			);
		});
		req.end();
	});
}

function readOptionsFromEnv(): DiscordCleanupOptions {
	const token =
		process.env.DISCORD_CLEANUP_TOKEN?.trim() ?? process.env.TOKEN?.trim();

	if (!token) {
		throw new Error('Missing DISCORD_CLEANUP_TOKEN or TOKEN in .env.');
	}

	return createDiscordCleanupOptions(token);
}

export function createDiscordCleanupOptions(
	token: string,
): DiscordCleanupOptions {
	return {
		token,
		whitelistedUsers: parseList(process.env.WHITELISTED_USERS),
		whitelistedFriendships: parseList(process.env.WHITELISTED_FRIENDSHIPS),
		baseDeleteDelayMs: readDelayFromEnv(),
		verbose: readVerboseFromEnv(),
	};
}

export class DiscordDmCleaner {
	private readonly token: string;
	private readonly targetUserId?: string;
	private readonly whitelistedUsers: Set<string>;
	private readonly whitelistedFriendships: Set<string>;
	private readonly baseDeleteDelayMs: number;
	private readonly verbose: boolean;
	private readonly signal?: AbortSignal;
	private currentUserId: string | null = null;

	constructor(options: DiscordCleanupOptions) {
		this.token = options.token;
		this.targetUserId = options.targetUserId;
		this.whitelistedUsers = new Set(options.whitelistedUsers ?? []);
		this.whitelistedFriendships = new Set(
			options.whitelistedFriendships ?? [],
		);
		this.baseDeleteDelayMs =
			options.baseDeleteDelayMs ?? DEFAULT_DELETE_DELAY_MS;
		this.verbose = options.verbose ?? false;
		this.signal = options.signal;
	}

	async run(): Promise<void> {
		throwIfAborted(this.signal);
		const currentUser = await this.fetchCurrentUser();
		if (!currentUser) {
			throw new Error('Token invalido.');
		}

		this.currentUserId = currentUser.id;
		this.log('-> Token valido.');

		const identifyData = await this.fetchIdentify();
		throwIfAborted(this.signal);
		if (this.targetUserId) {
			await this.cleanupTargetUserDm(this.targetUserId, identifyData);
			return;
		}

		await this.fetchDms(identifyData);
		await this.unfriendLeftovers(identifyData);
	}

	private log(message: string): void {
		if (this.verbose) console.log(message);
	}

	private randomDeleteDelay(): number {
		if (this.baseDeleteDelayMs <= 0) return 0;

		const offset = Math.floor(Math.random() * 51) + 25;
		return this.baseDeleteDelayMs + offset;
	}

	private retryDelayMs(body: RateLimitResponse | null): number {
		const retryAfter = body?.retry_after;
		if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
			return Math.ceil(retryAfter * 1000) + 100;
		}

		return Math.max(this.baseDeleteDelayMs * 5, 1000);
	}

	private async fetchJson<T>(
		path: string,
		method: HttpMethod = 'GET',
		expectBody = true,
	): Promise<JsonResponse<T>> {
		return fetchDiscordJson<T>(this.token, path, method, expectBody);
	}

	private async fetchCurrentUser(): Promise<DiscordUser | null> {
		const { status, body } = await this.fetchJson<DiscordUser>('/users/@me');
		return status === 200 ? body : null;
	}

	private fetchIdentify(): Promise<ReadyData> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let readyTimeout: NodeJS.Timeout | null = null;
			let heartbeatTimer: NodeJS.Timeout | null = null;
			const socket = new WebSocket(GATEWAY_URL);

			const finish = (callback: () => void): void => {
				if (settled) return;

				settled = true;
				if (readyTimeout) clearTimeout(readyTimeout);
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				callback();
			};

			readyTimeout = setTimeout(() => {
				finish(() => reject(new Error('Gateway timed out before READY.')));
				socket.close();
			}, DEFAULT_HTTP_TIMEOUT_MS);

			socket.on('open', () => {
				this.log('-> WebSocket conectado.');
			});

			socket.on('message', (rawData: RawData) => {
				let payload: GatewayPayload<ReadyData | GatewayHello>;

				try {
					payload = JSON.parse(
						rawData.toString(),
					) as GatewayPayload<ReadyData | GatewayHello>;
				} catch (error) {
					finish(() => reject(error));
					socket.close();
					return;
				}

				if (payload.op === 10) {
					const interval = (payload.d as GatewayHello).heartbeat_interval;
					heartbeatTimer = setInterval(() => {
						socket.send(JSON.stringify({ op: 1, d: null }));
					}, interval);
					socket.send(JSON.stringify(this.identifyPayload()));
					return;
				}

				if (payload.op === 0 && payload.t === 'READY') {
					finish(() => {
						socket.close();
						resolve(payload.d as ReadyData);
					});
				}
			});

			socket.on('error', (error: Error) => {
				finish(() => reject(error));
			});

			socket.on('close', () => {
				finish(() => reject(new Error('Gateway closed before READY.')));
			});
		});
	}

	private identifyPayload(): GatewayPayload {
		return {
			op: 2,
			d: {
				token: this.token,
				capabilities: 1021,
				properties: {
					...Constants.Properties,
					is_fast_connect: false,
					gateway_connect_reasons: 'AppSkeleton',
				},
				presence: {
					status: 'online',
					since: 0,
					activities: [],
					afk: false,
				},
				compress: false,
				client_state: {
					guild_versions: {},
					highest_last_message_id: '0',
					read_state_version: 0,
					user_guild_settings_version: -1,
					user_settings_version: -1,
					private_channels_version: '0',
				},
			},
		};
	}

	private async unfriendLeftovers(identifyData: ReadyData): Promise<void> {
		this.log('-> Excluindo amigos restantes.');

		for (const relationship of identifyData.relationships) {
			throwIfAborted(this.signal);
			const userId = relationship.user_id;
			if (
				this.whitelistedUsers.has(userId) ||
				this.whitelistedFriendships.has(userId)
			) {
				continue;
			}

			await this.deleteFriendship(userId);
			await sleep(FRIENDSHIP_DELETE_DELAY_MS, this.signal);
		}
	}

	private async fetchAllMessages(channelId: string): Promise<Message[]> {
		this.log(`-> Analisando canal: ${channelId}.`);

		const userMessages: Message[] = [];
		const initialMessages = await this.fetchMessagePage(channelId);
		if (initialMessages.length === 0) {
			this.log('-> DM vazia. Pulando.');
			return userMessages;
		}

		userMessages.push(...initialMessages);

		let lastMessage = initialMessages[initialMessages.length - 1].id;
		let lastPageSize = initialMessages.length;
		while (lastPageSize === MESSAGE_FETCH_LIMIT) {
			await sleep(MESSAGE_FETCH_DELAY_MS, this.signal);
			const moreMessages = await this.fetchMessagePage(
				channelId,
				lastMessage,
			);
			lastPageSize = moreMessages.length;
			if (lastPageSize === 0) break;

			userMessages.push(...moreMessages);
			lastMessage = moreMessages[moreMessages.length - 1].id;
		}

		return userMessages;
	}

	private async fetchMessagePage(
		channelId: string,
		before?: string,
	): Promise<Message[]> {
		const params = new URLSearchParams({
			limit: String(MESSAGE_FETCH_LIMIT),
		});
		if (before) params.set('before', before);

		const { body } = await this.fetchJson<Message[]>(
			`/channels/${channelId}/messages?${params.toString()}`,
		);

		return body ?? [];
	}

	private async wipeDm(
		messageList: Message[],
		userId: string,
		isGroup: boolean,
	): Promise<void> {
		if (!messageList.length) return;
		if (!this.currentUserId) throw new Error('Current user was not loaded.');

		let currentChannel = messageList[0].channel_id;
		this.log(`-> ID do canal atual: ${currentChannel}.`);

		for (const message of messageList) {
			throwIfAborted(this.signal);
			if (message.author.id !== this.currentUserId) continue;

			currentChannel = message.channel_id;
			await this.deleteMessage(currentChannel, message.id);
			const delay = this.randomDeleteDelay();
			if (delay > 0) await sleep(delay, this.signal);
		}

		if (this.whitelistedFriendships.has(userId)) return;

		await this.deleteFriendship(userId);
		await this.closeChannel(currentChannel, isGroup);
	}

	private async deleteMessage(
		channelId: string,
		messageId: string,
	): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const { status, body } = await this.fetchJson<RateLimitResponse>(
				`/channels/${channelId}/messages/${messageId}`,
				'DELETE',
			);

			if (status === 204) {
				this.log(
					`-> Mensagem ${messageId} excluida com sucesso no canal ${channelId}.`,
				);
				return;
			}

			if (status === 429) {
				const retryDelay = this.retryDelayMs(body);
				this.log(
					`-> Taxa limitada. Aguardando ${retryDelay}ms antes de continuar.`,
				);
				await sleep(retryDelay, this.signal);
				continue;
			}

			if (status === 403) {
				this.log(
					`-> Erro 403 na mensagem ${messageId}. Isso e normal quando a mensagem nao pode ser excluida.`,
				);
				return;
			}

			this.log(
				`-> Falha ao excluir mensagem ${messageId} no canal ${channelId}. Code: ${status}.`,
			);
			return;
		}
	}

	private async deleteFriendship(userId: string): Promise<void> {
		const { status } = await this.fetchJson(
			`/users/@me/relationships/${userId}`,
			'DELETE',
			false,
		);

		if (status === 204) {
			this.log(`-> Amizade deletada com ${userId}.`);
			return;
		}

		this.log(`-> Falha ao excluir amizade com ${userId}. Code: ${status}.`);
	}

	private async closeChannel(
		channelId: string,
		isGroup: boolean,
	): Promise<void> {
		const path = isGroup
			? `/channels/${channelId}?silent=true`
			: `/channels/${channelId}`;
		const { status } = await this.fetchJson(path, 'DELETE', false);

		if (
			(!isGroup && status === 204) ||
			(isGroup && [200, 204].includes(status))
		) {
			return;
		}

		this.log(
			`-> Falha ao ${isGroup ? 'sair do grupo' : 'fechar DM'} ${channelId}. Code: ${status}.`,
		);
	}

	private async fetchDms(identifyData: ReadyData): Promise<void> {
		for (const dm of identifyData.private_channels) {
			throwIfAborted(this.signal);
			if (dm.type === 1) {
				const userId = dm.user_id ?? dm.recipient_ids?.[0];
				if (!userId || this.whitelistedUsers.has(userId)) continue;

				this.log(`-> ID do usuario: ${userId}.`);
				this.log(`-> ID do canal: ${dm.id}.`);

				const messages = await this.fetchAllMessages(dm.id);
				await this.wipeDm(messages, userId, false);
				continue;
			}

			if (dm.type === 3) {
				const ownerId = dm.owner_id ?? dm.recipient_ids?.[0];
				if (!ownerId || this.whitelistedUsers.has(ownerId)) continue;

				this.log(`-> ID do proprietario do grupo: ${ownerId}.`);
				this.log(`-> ID do canal: ${dm.id}.`);

				const messages = await this.fetchAllMessages(dm.id);
				await this.wipeDm(messages, ownerId, true);
			}
		}
	}

	private async cleanupTargetUserDm(
		targetUserId: string,
		identifyData: ReadyData,
	): Promise<void> {
		if (this.whitelistedUsers.has(targetUserId)) {
			throw new Error('Esse usuario esta na whitelist de limpeza.');
		}

		const dm = identifyData.private_channels.find((channel) => {
			if (channel.type !== 1) return false;
			return (
				channel.user_id === targetUserId ||
				channel.recipient_ids?.includes(targetUserId)
			);
		});

		if (!dm) {
			this.log(`-> DM com ${targetUserId} nao encontrada. Removendo contato.`);
			await this.deleteFriendship(targetUserId);
			return;
		}

		this.log(`-> Limpando DM do usuario ${targetUserId}.`);
		this.log(`-> ID do canal: ${dm.id}.`);

		const messages = await this.fetchAllMessages(dm.id);
		await this.wipeTargetDm(dm.id, messages, targetUserId);
	}

	private async wipeTargetDm(
		channelId: string,
		messageList: Message[],
		targetUserId: string,
	): Promise<void> {
		if (!this.currentUserId) throw new Error('Current user was not loaded.');

		for (const message of messageList) {
			throwIfAborted(this.signal);
			if (message.author.id !== this.currentUserId) continue;

			await this.deleteMessage(channelId, message.id);
			const delay = this.randomDeleteDelay();
			if (delay > 0) await sleep(delay, this.signal);
		}

		await this.deleteFriendship(targetUserId);
		await this.closeChannel(channelId, false);
	}
}

export async function runDiscordDmCleanup(
	options: DiscordCleanupOptions,
): Promise<void> {
	const cleaner = new DiscordDmCleaner(options);
	await cleaner.run();
}

if (require.main === module) {
	runDiscordDmCleanup(readOptionsFromEnv()).catch((error: unknown) => {
		if (readVerboseFromEnv()) console.error(error);
		process.exitCode = 1;
	});
}
