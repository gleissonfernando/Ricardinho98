// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { Constants } from './constants';
export {
	createDiscordCleanupOptions,
	DiscordDmCleaner,
	runDiscordDmCleanup,
	type DiscordCleanupOptions,
} from './clearDm';
export {
	DiscordRichPresenceSession,
	type RichPresenceRuntimeConfig,
} from './richPresence';

const API_BASE_URL = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?encoding=json&v=10';
const DEFAULT_HTTP_TIMEOUT_MS = 30000;

type HttpMethod = 'GET' | 'DELETE' | 'POST';

type JsonResponse<T> = {
	status: number;
	body: T | null;
};

type DiscordUser = {
	id: string;
};

type GatewayPayload<T = unknown> = {
	op: number;
	t?: string;
	d: T;
};

type GatewayHello = {
	heartbeat_interval: number;
};

type DiscordGuild = {
	id: string;
	name: string;
};

type DiscordChannel = {
	id: string;
	name: string;
	type: number;
	guild_id?: string;
};

export type DiscordGuildOption = {
	id: string;
	name: string;
};

export type DiscordVoiceChannelOption = {
	id: string;
	name: string;
	guildId: string;
};

export type VoiceRuntimeStatus =
	| 'connected'
	| 'disconnected'
	| 'reconnecting';

export type VoiceSessionUpdate = {
	status: VoiceRuntimeStatus;
	connectedAt?: string;
};

export type DiscordTokenValidation = {
	valid: boolean;
	userId?: string;
};

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

function apiUrl(path: string): string {
	return `${API_BASE_URL}${path}`;
}

function fetchDiscordJson<T>(
	token: string,
	path: string,
	method: HttpMethod = 'GET',
	expectBody = true,
	body?: unknown,
): Promise<JsonResponse<T>> {
	return new Promise((resolve, reject) => {
		const url = new URL(apiUrl(path));
		const bodyJson = body === undefined ? undefined : JSON.stringify(body);
		const options: RequestOptions = {
			hostname: url.hostname,
			path: `${url.pathname}${url.search}`,
			method,
			headers: {
				...discordHeaders(token),
				...(bodyJson ? { 'Content-Length': Buffer.byteLength(bodyJson) } : {}),
			},
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
			req.destroy(new Error(`Discord request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms.`));
		});
		if (bodyJson) req.write(bodyJson);
		req.end();
	});
}

export async function validateDiscordToken(
	token: string,
): Promise<DiscordTokenValidation> {
	const { status, body } = await fetchDiscordJson<DiscordUser>(
		token,
		'/users/@me',
	);

	return status === 200 && body?.id
		? {
			valid: true,
			userId: body.id,
		}
		: {
			valid: false,
		};
}

export async function fetchDiscordGuildOptions(
	token: string,
): Promise<DiscordGuildOption[]> {
	const { status, body } = await fetchDiscordJson<DiscordGuild[]>(
		token,
		'/users/@me/guilds',
	);
	if (status !== 200) return [];

	return (body ?? []).map((guild) => ({
		id: guild.id,
		name: guild.name,
	}));
}

export async function fetchDiscordVoiceChannelOptions(
	token: string,
	guildId: string,
): Promise<DiscordVoiceChannelOption[]> {
	const { status, body } = await fetchDiscordJson<DiscordChannel[]>(
		token,
		`/guilds/${guildId}/channels`,
	);
	if (status !== 200) return [];

	return (body ?? [])
		.filter((channel) => channel.type === 2 || channel.type === 13)
		.map((channel) => ({
			id: channel.id,
			name: channel.name,
			guildId,
		}));
}

function defaultPresence(activities: unknown[] = []): Record<string, unknown> {
	return {
		status: 'online',
		since: 0,
		activities,
		afk: false,
	};
}

function gatewayIdentifyPayload(
	token: string,
	activities: unknown[] = [],
): GatewayPayload {
	return {
		op: 2,
		d: {
			token,
			capabilities: 1021,
			properties: {
				...Constants.Properties,
				is_fast_connect: false,
				gateway_connect_reasons: 'AppSkeleton',
			},
			presence: defaultPresence(activities),
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

export class DiscordVoiceSession {
	private socket: WebSocket | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempt = 0;
	private desiredActive = false;
	private guildId: string | null = null;
	private channelId: string | null = null;
	private connectedAt: string | undefined;

	constructor(
		private readonly token: string,
		private readonly onStatusChange: (update: VoiceSessionUpdate) => void,
	) {}

	start(guildId: string, channelId: string): void {
		this.guildId = guildId;
		this.channelId = channelId;
		this.desiredActive = true;
		this.clearReconnectTimer();
		this.connect();
	}

	changeChannel(guildId: string, channelId: string): void {
		this.guildId = guildId;
		this.channelId = channelId;
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.sendVoiceState(channelId);
			return;
		}

		this.start(guildId, channelId);
	}

	stop(): void {
		this.desiredActive = false;
		this.clearReconnectTimer();
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.sendVoiceState(null);
		}
		this.closeSocket();
		this.connectedAt = undefined;
		this.onStatusChange({
			status: 'disconnected',
			connectedAt: undefined,
		});
	}

	private connect(): void {
		if (!this.guildId || !this.channelId) return;

		this.closeSocket();
		this.onStatusChange({
			status: 'reconnecting',
			connectedAt: this.connectedAt,
		});

		const socket = new WebSocket(GATEWAY_URL);
		this.socket = socket;

		socket.on('message', (rawData: RawData) => {
			let payload: GatewayPayload;
			try {
				payload = JSON.parse(rawData.toString()) as GatewayPayload;
			} catch {
				return;
			}

			if (payload.op === 10) {
				this.startHeartbeat((payload.d as GatewayHello).heartbeat_interval);
				this.send(gatewayIdentifyPayload(this.token));
				return;
			}

			if (payload.op === 0 && payload.t === 'READY') {
				this.reconnectAttempt = 0;
				this.sendVoiceState(this.channelId);
				this.connectedAt = this.connectedAt ?? new Date().toISOString();
				this.onStatusChange({
					status: 'connected',
					connectedAt: this.connectedAt,
				});
				return;
			}

			if (payload.op === 7) {
				socket.close();
			}
		});

		socket.on('close', () => {
			this.clearHeartbeat();
			if (this.socket === socket) this.socket = null;
			if (this.desiredActive) this.scheduleReconnect();
		});

		socket.on('error', () => {
			socket.close();
		});
	}

	private sendVoiceState(channelId: string | null): void {
		if (!this.guildId) return;

		this.send({
			op: 4,
			d: {
				guild_id: this.guildId,
				channel_id: channelId,
				self_mute: false,
				self_deaf: false,
				self_video: false,
			},
		});
	}

	private scheduleReconnect(): void {
		this.onStatusChange({
			status: 'reconnecting',
			connectedAt: this.connectedAt,
		});
		this.clearReconnectTimer();
		const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	private send(payload: GatewayPayload): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(payload));
		}
	}

	private startHeartbeat(interval: number): void {
		this.clearHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.send({ op: 1, d: null });
		}, interval);
		this.send({ op: 1, d: null });
	}

	private closeSocket(): void {
		this.clearHeartbeat();
		if (this.socket) {
			this.socket.removeAllListeners();
			if (this.socket.readyState === WebSocket.OPEN) {
				this.socket.close();
			}
			this.socket = null;
		}
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}
}

