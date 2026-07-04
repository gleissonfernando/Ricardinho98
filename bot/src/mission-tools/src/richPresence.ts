// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { Constants } from './constants';

const API_BASE_URL = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?encoding=json&v=10';
const DEFAULT_HTTP_TIMEOUT_MS = 30000;

type GatewayPayload<T = unknown> = {
	op: number;
	t?: string;
	d: T;
};

type GatewayHello = {
	heartbeat_interval: number;
};

type ExternalApplicationAsset = {
	url: string;
	external_asset_path: string;
};

type JsonResponse<T> = {
	status: number;
	body: T | null;
};

export type RichPresenceRuntimeConfig = {
	applicationId?: string;
	activityType?: 0 | 1 | 2 | 3 | 5;
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
	body?: unknown,
): Promise<JsonResponse<T>> {
	return new Promise((resolve, reject) => {
		const url = new URL(`${API_BASE_URL}${path}`);
		const bodyJson = body === undefined ? undefined : JSON.stringify(body);
		const options: RequestOptions = {
			hostname: url.hostname,
			path: `${url.pathname}${url.search}`,
			method: 'POST',
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
					const responseBody = data.length > 0 ? (JSON.parse(data) as T) : null;
					resolve({ status, body: responseBody });
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
		if (bodyJson) req.write(bodyJson);
		req.end();
	});
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

function normalizeActivityImageAsset(value?: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return trimmed;
		}

		return url.toString().replace(/[?&]$/, '');
	} catch {
		return trimmed;
	}
}

function isHttpUrl(value?: string): boolean {
	if (!value) return false;

	try {
		const protocol = new URL(value).protocol;
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

async function proxyExternalActivityAssets(
	token: string,
	applicationId: string,
	images: string[],
): Promise<Map<string, string>> {
	const urls = [
		...new Set(images.map(normalizeActivityImageAsset).filter(Boolean)),
	];
	if (urls.length === 0) return new Map();

	const { status, body } = await fetchDiscordJson<ExternalApplicationAsset[]>(
		token,
		`/applications/${applicationId}/external-assets`,
		{ urls },
	);

	if (status < 200 || status >= 300 || !Array.isArray(body)) {
		throw new Error(`Discord external-assets retornou status ${status}.`);
	}

	return new Map(
		body
			.filter((asset) => asset.url && asset.external_asset_path)
			.map((asset) => [asset.url, `mp:${asset.external_asset_path}`]),
	);
}

async function uploadApplicationAsset(
	token: string,
	applicationId: string,
	name: string,
	imageUrl: string,
): Promise<string> {
	const imageRes = await fetch(imageUrl);
	if (!imageRes.ok) {
		throw new Error(`Download de asset falhou com status ${imageRes.status}.`);
	}

	const buffer = await imageRes.arrayBuffer();
	const contentType = imageRes.headers.get('content-type') ?? 'image/png';
	const base64 = Buffer.from(buffer).toString('base64');
	const dataUri = `data:${contentType};base64,${base64}`;

	const { status, body } = await fetchDiscordJson<{ id: string }>(
		token,
		`/applications/${applicationId}/assets`,
		{
			name: name.replace(/[^a-z0-9_]/gi, '_').slice(0, 32) || 'asset',
			image: dataUri,
			type: 1,
		},
	);

	if (status < 200 || status >= 300 || !body?.id) {
		throw new Error(
			`Upload de asset falhou com status ${status}: ${JSON.stringify(body)}`,
		);
	}

	return body.id;
}

function isDiscordUrl(url: string): boolean {
	const hostname = new URL(url).hostname.toLowerCase();
	return (
		hostname.endsWith('discordapp.net') ||
		hostname.endsWith('discordapp.com') ||
		hostname.endsWith('discord.com')
	);
}

async function resolveDiscordImageAsset(
	token: string,
	applicationId: string,
	name: string,
	imageUrl: string,
): Promise<string> {
	try {
		return await uploadApplicationAsset(token, applicationId, name, imageUrl);
	} catch (error) {
		console.error(
			'Could not upload Discord CDN image as application asset. Trying external asset proxy:',
			error,
		);
	}

	try {
		const proxiedAssets = await proxyExternalActivityAssets(token, applicationId, [
			imageUrl,
		]);
		return proxiedAssets.get(imageUrl) ?? imageUrl;
	} catch (error) {
		console.error('Could not proxy Discord CDN image asset:', error);
		return imageUrl;
	}
}

function isSupportedStreamingUrl(value?: string): boolean {
	if (!value) return false;

	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return (
			hostname === 'twitch.tv' ||
			hostname.endsWith('.twitch.tv') ||
			hostname === 'youtube.com' ||
			hostname.endsWith('.youtube.com') ||
			hostname === 'youtu.be'
		);
	} catch {
		return false;
	}
}

function richPresenceActivity(
	config: RichPresenceRuntimeConfig,
	fallbackApplicationId?: string,
): Record<string, unknown> {
	const largeImage = config.largeImage;
	const smallImage = config.smallImage;
	const applicationId = config.applicationId || fallbackApplicationId;
	const startTimestamp = config.startTimestamp
		? new Date(config.startTimestamp).getTime()
		: undefined;
	const requestedType = config.activityType ?? 0;
	const activityType =
		requestedType === 1 && !isSupportedStreamingUrl(config.buttonUrl)
			? 0
			: requestedType;
	const activity: Record<string, unknown> = {
		name: config.name || 'Custom Activity',
		type: activityType,
		created_at: Date.now(),
	};

	if (applicationId) activity.application_id = applicationId;
	if (activityType === 1 && config.buttonUrl) {
		activity.url = config.buttonUrl;
	}
	if (config.description) activity.description = config.description;
	if (config.details) activity.details = config.details;
	if (config.state) activity.state = config.state;
	if (startTimestamp && Number.isFinite(startTimestamp)) {
		activity.timestamps = {
			start: startTimestamp,
		};
	}
	if (largeImage || smallImage) {
		activity.assets = {
			...(largeImage ? { large_image: largeImage } : {}),
			...(config.largeText ? { large_text: config.largeText } : {}),
			...(smallImage ? { small_image: smallImage } : {}),
			...(config.smallText ? { small_text: config.smallText } : {}),
		};
	}
	if (config.buttonLabel && config.buttonUrl) {
		activity.buttons = [
			{
				label: config.buttonLabel,
				url: config.buttonUrl,
			},
		];
	}

	return activity;
}

export class DiscordRichPresenceSession {
	private socket: WebSocket | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private config: RichPresenceRuntimeConfig = {};
	private active = false;
	private configVersion = 0;
	private reconnectAttempt = 0;

	constructor(
		private readonly token: string,
		private readonly onStatusChange: (status: 'active' | 'inactive') => void,
		private readonly applicationId?: string,
	) {}

	start(config: RichPresenceRuntimeConfig): void {
		this.active = true;
		void this.applyConfig(config, true);
	}

	update(config: RichPresenceRuntimeConfig): void {
		if (!this.active) {
			this.start(config);
			return;
		}

		void this.applyConfig(config, false);
	}

	stop(): void {
		this.active = false;
		this.clearReconnectTimer();
		this.send({
			op: 3,
			d: defaultPresence([]),
		});
		this.closeSocket();
		this.onStatusChange('inactive');
	}

	private async applyConfig(
		config: RichPresenceRuntimeConfig,
		shouldConnect: boolean,
	): Promise<void> {
		const version = ++this.configVersion;
		const resolvedConfig = await this.resolveExternalAssets(config);
		if (version !== this.configVersion || !this.active) return;

		this.config = resolvedConfig;
		if (shouldConnect || !this.socket) {
			this.connect();
			return;
		}

		this.sendPresence();
	}

	private async resolveExternalAssets(
		config: RichPresenceRuntimeConfig,
	): Promise<RichPresenceRuntimeConfig> {
		const applicationId = config.applicationId || this.applicationId;
		if (!applicationId) return config;

		const largeImage = normalizeActivityImageAsset(config.largeImage);
		const smallImage = normalizeActivityImageAsset(config.smallImage);
		const discordImages = [largeImage, smallImage].filter(
			(image): image is string =>
				!!image && isHttpUrl(image) && isDiscordUrl(image),
		);
		const externalImages = [largeImage, smallImage].filter(
			(image): image is string => {
				if (!image) return false;
				if (!isHttpUrl(image)) return false;
				if (image.startsWith('mp:')) return false;

				// Ignorar URLs do próprio Discord
				const hostname = new URL(image).hostname.toLowerCase();
				const isDiscordUrl =
					hostname.endsWith('discordapp.com') ||
					hostname.endsWith('discordapp.net') ||
					hostname.endsWith('discord.com');
				return !isDiscordUrl;
			},
		);
		if (discordImages.length === 0 && externalImages.length === 0) return config;

		try {
			const proxiedAssets =
				externalImages.length > 0
					? await proxyExternalActivityAssets(
						this.token,
						applicationId,
						externalImages,
					)
					: new Map<string, string>();
			const uploadedAssets = new Map<string, string>();

			if (largeImage && discordImages.includes(largeImage)) {
				uploadedAssets.set(
					largeImage,
					await resolveDiscordImageAsset(
						this.token,
						applicationId,
						'rich_presence_large',
						largeImage,
					),
				);
			}
			if (smallImage && discordImages.includes(smallImage)) {
				uploadedAssets.set(
					smallImage,
					await resolveDiscordImageAsset(
						this.token,
						applicationId,
						'rich_presence_small',
						smallImage,
					),
				);
			}

			return {
				...config,
				largeImage: largeImage
					? uploadedAssets.get(largeImage) ??
						proxiedAssets.get(largeImage) ??
						largeImage
					: undefined,
				smallImage: smallImage
					? uploadedAssets.get(smallImage) ??
						proxiedAssets.get(smallImage) ??
						smallImage
					: undefined,
			};
		} catch (error) {
			console.error('Could not proxy Rich Presence image assets:', error);
			return config;
		}
	}

	private connect(): void {
		this.clearReconnectTimer();
		this.closeSocket();
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
				this.send(
					gatewayIdentifyPayload(this.token, [
						richPresenceActivity(this.config, this.applicationId),
					]),
				);
				return;
			}

			if (payload.op === 0 && payload.t === 'READY') {
				this.reconnectAttempt = 0;
				this.sendPresence();
				this.onStatusChange('active');
				return;
			}

			if (payload.op === 7 && this.active) {
				socket.close();
			}
		});

		socket.on('close', () => {
			this.clearHeartbeat();
			if (this.socket === socket) this.socket = null;
			if (this.active) this.scheduleReconnect();
		});

		socket.on('error', () => {
			socket.close();
		});
	}

	private sendPresence(): void {
		const activity = richPresenceActivity(this.config, this.applicationId);
		console.log('Enviando activity:', JSON.stringify(activity, null, 2));
		this.send({
			op: 3,
			d: defaultPresence([activity]),
		});
		this.onStatusChange('active');
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

	private scheduleReconnect(): void {
		this.clearReconnectTimer();
		const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			if (this.active) this.connect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}
}
