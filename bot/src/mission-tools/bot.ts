// Credito: Perfil Discord https://discord.com/users/1411202571804348507
console.clear();

import { Client } from '@discordjs/core';
import { REST } from '@discordjs/rest';
import { WebSocketManager } from '@discordjs/ws';
import {
	APIInteraction,
	APIModalSubmitInteraction,
	ApplicationCommandType,
	ComponentType,
	GatewayDispatchEvents,
	GatewayIntentBits,
	GatewayReadyDispatchData,
	InteractionType,
	MessageFlags,
	TextInputStyle,
} from 'discord-api-types/v10';
import {
	APPLY_RICH_PRESENCE_CUSTOM_ID,
	buildMainPanelPayload,
	CHANGE_VOICE_CHANNEL_CUSTOM_ID,
	CONFIGURE_RICH_PRESENCE_ADVANCED_CUSTOM_ID,
	CONFIGURE_RICH_PRESENCE_BUTTON_CUSTOM_ID,
	CONFIGURE_CLEAR_TARGET_USER_CUSTOM_ID,
	CONFIGURE_CLEAR_TOKEN_CUSTOM_ID,
	CONFIGURE_RICH_PRESENCE_IMAGES_CUSTOM_ID,
	CONFIGURE_RICH_PRESENCE_LARGE_IMAGE_CUSTOM_ID,
	CONFIGURE_MISSION_TOKEN_CUSTOM_ID,
	CONFIGURE_RICH_PRESENCE_CUSTOM_ID,
	CONFIGURE_RICH_PRESENCE_SMALL_IMAGE_CUSTOM_ID,
	CONFIGURE_RICH_PRESENCE_TOKEN_CUSTOM_ID,
	CONFIGURE_USERNAME_CHECKER_CUSTOM_ID,
	CONFIGURE_VOICE_TOKEN_CUSTOM_ID,
	DEACTIVATE_CLEAR_CUSTOM_ID,
	DEACTIVATE_MISSION_CUSTOM_ID,
	MAIN_PANEL_CLEAR_VALUE,
	MAIN_PANEL_DELETE_DM_VALUE,
	MAIN_PANEL_MISSION_VALUE,
	MAIN_PANEL_RICH_PRESENCE_VALUE,
	MAIN_PANEL_SELECT_CUSTOM_ID,
	MAIN_PANEL_USERNAME_CHECKER_VALUE,
	MAIN_PANEL_VOICE_VALUE,
	mapMissionStatusToPanel,
	MISSION_CONCURRENCY_SELECT_CUSTOM_ID,
	PanelSelectOption,
	PersistentPanels,
	RESET_RICH_PRESENCE_CUSTOM_ID,
	RICH_PRESENCE_ACTIVITY_TYPE_SELECT_CUSTOM_ID,
	SET_CLEAR_BULK_MODE_CUSTOM_ID,
	SET_CLEAR_USER_DM_MODE_CUSTOM_ID,
	START_RICH_PRESENCE_CUSTOM_ID,
	START_CLEAR_CUSTOM_ID,
	START_MISSION_CUSTOM_ID,
	START_USERNAME_CHECKER_CUSTOM_ID,
	START_VOICE_CUSTOM_ID,
	STOP_RICH_PRESENCE_CUSTOM_ID,
	STOP_USERNAME_CHECKER_CUSTOM_ID,
	STOP_VOICE_CUSTOM_ID,
	VOICE_CHANNEL_SELECT_CUSTOM_ID,
	VOICE_GUILD_SELECT_CUSTOM_ID,
} from './src/missionPanel';
import {
	createDiscordCleanupOptions,
	DiscordRichPresenceSession,
	DiscordVoiceSession,
	fetchDiscordGuildOptions,
	fetchDiscordVoiceChannelOptions,
	RichPresenceRuntimeConfig,
	runDiscordDmCleanup,
	validateDiscordToken,
} from './src/discord';
import { MissionQueue } from './src/missionQueue';
import { runMissionFlow } from './src/missionRunner';
import {
	PanelStore,
	type PanelSystemStatus,
	RichPresenceActivityType,
} from './src/panelStore';
import { TokenStore } from './src/tokenStore';
import {
	CheckerOptions,
	CheckerStats,
	DiscordUsernameChecker,
} from './src/user';

const PANEL_COMMAND_NAME = 'mission-panel';
const CLEAR_TOKEN_MODAL_CUSTOM_ID = 'clear:token-modal';
const CLEAR_TARGET_USER_MODAL_CUSTOM_ID = 'clear:target-user-modal';
const MISSION_TOKEN_MODAL_CUSTOM_ID = 'mission:token-modal';
const VOICE_TOKEN_MODAL_CUSTOM_ID = 'voice:token-modal';
const VOICE_CONFIG_MODAL_CUSTOM_ID = 'voice:config-modal';
const RICH_PRESENCE_TOKEN_MODAL_CUSTOM_ID = 'rich-presence:token-modal';
const RICH_PRESENCE_CONFIG_MODAL_CUSTOM_ID = 'rich-presence:config-modal';
const RICH_PRESENCE_BUTTON_MODAL_CUSTOM_ID = 'rich-presence:button-modal';
const RICH_PRESENCE_IMAGES_MODAL_CUSTOM_ID = 'rich-presence:images-modal';
const RICH_PRESENCE_ADVANCED_MODAL_CUSTOM_ID = 'rich-presence:advanced-modal';
const RICH_PRESENCE_LARGE_IMAGE_MODAL_CUSTOM_ID =
	'rich-presence:large-image-modal';
const RICH_PRESENCE_SMALL_IMAGE_MODAL_CUSTOM_ID =
	'rich-presence:small-image-modal';
const USERNAME_CHECKER_CONFIG_MODAL_CUSTOM_ID =
	'username-checker:config-modal';
const TOKEN_INPUT_CUSTOM_ID = 'user_token';
const CLEAR_TARGET_USER_ID_INPUT_CUSTOM_ID = 'clear_target_user_id';
const VOICE_GUILD_ID_INPUT_CUSTOM_ID = 'voice_guild_id';
const VOICE_CHANNEL_ID_INPUT_CUSTOM_ID = 'voice_channel_id';
const USERNAME_LENGTH_INPUT_CUSTOM_ID = 'username_length';
const USERNAME_CONCURRENCY_INPUT_CUSTOM_ID = 'username_concurrency';
const USERNAME_REQUEST_DELAY_INPUT_CUSTOM_ID = 'username_request_delay';
const RICH_ACTIVITY_NAME_INPUT_CUSTOM_ID = 'rich_name';
const RICH_DESCRIPTION_INPUT_CUSTOM_ID = 'rich_description';
const RICH_STATE_INPUT_CUSTOM_ID = 'rich_state';
const RICH_DETAILS_INPUT_CUSTOM_ID = 'rich_details';
const RICH_LARGE_IMAGE_TEXT_INPUT_CUSTOM_ID = 'rich_large_image_text';
const RICH_BUTTON_LABEL_INPUT_CUSTOM_ID = 'rich_button_label';
const RICH_BUTTON_URL_INPUT_CUSTOM_ID = 'rich_button_url';
const RICH_APPLICATION_ID_INPUT_CUSTOM_ID = 'rich_application_id';
const RICH_START_TIME_INPUT_CUSTOM_ID = 'rich_start_time';
const RICH_LARGE_IMAGE_URL_INPUT_CUSTOM_ID = 'rich_large_image_url';
const RICH_SMALL_IMAGE_URL_INPUT_CUSTOM_ID = 'rich_small_image_url';
const RICH_LARGE_IMAGE_UPLOAD_CUSTOM_ID = 'rich_large_image_upload';
const RICH_SMALL_IMAGE_UPLOAD_CUSTOM_ID = 'rich_small_image_upload';
const MODAL_LABEL_COMPONENT_TYPE = 18;
const MODAL_FILE_UPLOAD_COMPONENT_TYPE = 19;

const botToken = process.env.BOT_TOKEN?.trim();
const guildId = process.env.GUILD_ID?.trim();
let applicationId =
	process.env.APPLICATION_ID?.trim() || process.env.CLIENT_ID?.trim() || '';
const richPresenceApplicationId =
	process.env.RICH_PRESENCE_APPLICATION_ID?.trim();
const richPresenceAssetChannelId =
	process.env.RICH_PRESENCE_ASSET_CHANNEL_ID?.trim();

if (!botToken) {
	console.error('Missing BOT_TOKEN. Add BOT_TOKEN=your_bot_token to .env.');
	process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(botToken);
const gateway = new WebSocketManager({
	token: botToken,
	intents: GatewayIntentBits.Guilds,
	rest,
});
const client = new Client({ rest, gateway });
const tokenStore = new TokenStore();
const panelStore = new PanelStore();
const missionQueue = new MissionQueue(5);
const missionRunVersions = new Map<string, number>();
const deferredReplies = new Set<string>();
const acknowledgedInteractions = new Set<string>();
const voiceSessions = new Map<
	string,
	{ token: string; session: DiscordVoiceSession }
>();
const richPresenceSessions = new Map<
	string,
	{ token: string; session: DiscordRichPresenceSession }
>();
const missionRichPresenceSnapshots = new Map<
	string,
	{
		runVersion: number;
		wasActive: boolean;
		config: RichPresenceRuntimeConfig;
		lastGame?: string;
	}
>();
const usernameCheckerSessions = new Map<string, DiscordUsernameChecker>();

function isDiscordApiErrorCode(error: unknown, code: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === code
	);
}

function isExpiredOrAcknowledgedInteraction(error: unknown): boolean {
	return (
		isDiscordApiErrorCode(error, 10062) ||
		isDiscordApiErrorCode(error, 40060)
	);
}

function getInteractionUserId(interaction: APIInteraction): string | null {
	const data = interaction as any;
	return data.member?.user?.id ?? data.user?.id ?? null;
}

function getInteractionChannelId(interaction: APIInteraction): string | null {
	const data = interaction as any;
	return data.channel_id ?? null;
}

function getInteractionMessageId(interaction: APIInteraction): string | null {
	const data = interaction as any;
	return data.message?.id ?? null;
}

function getSelectedValue(interaction: APIInteraction): string | null {
	const data = interaction as any;
	return data.data?.values?.[0] ?? null;
}

function createPanels(userId: string): PersistentPanels {
	return new PersistentPanels(client, panelStore, userId, () =>
		hasValidStoredToken(userId),
	);
}

function stopUserRuntimeSessions(userId: string): void {
	voiceSessions.get(userId)?.session.stop();
	voiceSessions.delete(userId);
	richPresenceSessions.get(userId)?.session.stop();
	richPresenceSessions.delete(userId);
}

function nextMissionRunVersion(userId: string): number {
	return (missionRunVersions.get(userId) ?? 0) + 1;
}

function activateMissionRun(userId: string, version: number): void {
	missionRunVersions.set(userId, version);
}

function invalidateMissionRun(userId: string): void {
	missionRunVersions.set(userId, nextMissionRunVersion(userId));
}

function isCurrentMissionRun(userId: string, version: number): boolean {
	return missionRunVersions.get(userId) === version;
}

async function markTokenInvalid(userId: string): Promise<void> {
	stopUserRuntimeSessions(userId);
	await tokenStore.delete(userId);
	if (await panelStore.hasUser(userId)) {
		await panelStore.updateUser(userId, {
			tokenConfigured: false,
			voiceStatus: 'disconnected',
			voiceConnectedAt: undefined,
			richPresenceStatus: 'inactive',
		});
	}
}

async function getValidUserToken(userId: string): Promise<string | null> {
	const token = await tokenStore.get(userId);
	if (!token) {
		if (await panelStore.hasUser(userId)) {
			await panelStore.updateUser(userId, {
				tokenConfigured: false,
			});
		}
		return null;
	}

	const validation = await validateDiscordToken(token);
	if (!validation.valid) {
		await markTokenInvalid(userId);
		return null;
	}

	if (await panelStore.hasUser(userId)) {
		await panelStore.updateUser(userId, {
			tokenConfigured: true,
		});
	}
	return token;
}

async function hasValidStoredToken(userId: string): Promise<boolean> {
	return Boolean(await getValidUserToken(userId));
}

async function requireValidTokenAfterAck(
	interaction: APIInteraction,
	userId: string,
): Promise<string | null> {
	const token = await getValidUserToken(userId);
	if (token) return token;

	await safeReplyEphemeral(
		interaction,
		'Token invalido ou ausente. Configure o token novamente.',
	);
	return null;
}

function getModalValue(
	interaction: APIModalSubmitInteraction,
	customId: string,
): string | null {
	const component = findModalComponent(interaction, customId);
	return typeof component?.value === 'string' ? component.value : null;
}

type ModalComponentPayload = {
	component?: ModalComponentPayload;
	components?: ModalComponentPayload[];
	custom_id?: string;
	value?: string;
	values?: string[];
};

type ModalAttachmentPayload = {
	content_type?: string;
	filename?: string;
	id?: string;
	proxy_url?: string;
	url?: string;
};

type UploadedRichPresenceImages = {
	largeImage?: string;
	smallImage?: string;
};

function findModalComponent(
	interaction: APIModalSubmitInteraction,
	customId: string,
): ModalComponentPayload | null {
	return findModalComponentInList(
		(interaction.data.components ?? []) as ModalComponentPayload[],
		customId,
	);
}

function findModalComponentInList(
	components: ModalComponentPayload[],
	customId: string,
): ModalComponentPayload | null {
	for (const component of components) {
		if (component.custom_id === customId) return component;

		if (component.component) {
			const found = findModalComponentInList([component.component], customId);
			if (found) return found;
		}

		if (component.components) {
			const found = findModalComponentInList(component.components, customId);
			if (found) return found;
		}
	}

	return null;
}

function buildTokenModal(customId: string) {
	const titles: Record<string, string> = {
		[CLEAR_TOKEN_MODAL_CUSTOM_ID]: 'Configure Clear Token',
		[MISSION_TOKEN_MODAL_CUSTOM_ID]: 'Configure Mission Token',
		[VOICE_TOKEN_MODAL_CUSTOM_ID]: 'Configure Voice Token',
		[RICH_PRESENCE_TOKEN_MODAL_CUSTOM_ID]: 'Configure Rich Presence Token',
	};

	return {
		title: titles[customId] ?? 'Configure Token',
		custom_id: customId,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: TOKEN_INPUT_CUSTOM_ID,
						label: 'Token autorizado',
						style: TextInputStyle.Short,
						min_length: 10,
						max_length: 2048,
						required: true,
						placeholder: 'Cole o token autorizado.',
					},
				],
			},
		],
	} as any;
}

function buildClearTargetUserModal(
	record?: Awaited<ReturnType<typeof panelStore.getUser>>,
) {
	return {
		title: 'Limpar DM por User ID',
		custom_id: CLEAR_TARGET_USER_MODAL_CUSTOM_ID,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: CLEAR_TARGET_USER_ID_INPUT_CUSTOM_ID,
						label: 'User ID da pessoa',
						style: TextInputStyle.Short,
						min_length: 10,
						max_length: 32,
						required: true,
						placeholder: 'Cole o ID do usuario.',
						value: record?.clearTargetUserId,
					},
				],
			},
		],
	} as any;
}

function buildRichPresenceConfigModal(
	config: RichPresenceRuntimeConfig = {},
) {
	return {
		title: 'Conteudo do Rich Presence',
		custom_id: RICH_PRESENCE_CONFIG_MODAL_CUSTOM_ID,
		components: [
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Nome da atividade',
				description: 'Texto principal que aparece depois do tipo selecionado.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_ACTIVITY_NAME_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 128,
					required: true,
					value: config.name,
				},
			},
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Descricao',
				description: 'Resumo interno da atividade. Nem sempre aparece no perfil.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_DESCRIPTION_INPUT_CUSTOM_ID,
					style: TextInputStyle.Paragraph,
					max_length: 256,
					required: false,
					value: config.description,
				},
			},
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Estado',
				description: 'Linha de status curta. Exemplo: Em lobby, Solo, Online.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_STATE_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 128,
					required: false,
					value: config.state,
				},
			},
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Detalhes',
				description: 'Linha principal abaixo do nome. Exemplo: Capitulo 1.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_DETAILS_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 128,
					required: false,
					value: config.details,
				},
			},
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Texto imagem grande',
				description: 'Texto ao passar o mouse na imagem grande.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_LARGE_IMAGE_TEXT_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 128,
					required: false,
					value: config.largeText,
				},
			},
		],
	} as any;
}

function buildRichPresenceAdvancedModal(
	config: RichPresenceRuntimeConfig = {},
) {
	return {
		title: 'Rich Presence avancado',
		custom_id: RICH_PRESENCE_ADVANCED_MODAL_CUSTOM_ID,
		components: [
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'ID de um bot criado na sua conta',
				description: 'Application ID usado para assets e Rich Presence completo.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_APPLICATION_ID_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 32,
					required: false,
					value: config.applicationId,
				},
			},
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Inicio (DD/MM/AAAA HH:MM:SS)',
				description: 'Opcional. Use agora, ISO, ou deixe vazio.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_START_TIME_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 32,
					required: false,
					placeholder: 'Ex: 12/02/1990 14:12:00',
					value: config.startTimestamp,
				},
			},
		],
	} as any;
}

function buildRichPresenceButtonModal(
	config: RichPresenceRuntimeConfig = {},
) {
	return {
		title: 'Configurar Botao',
		custom_id: RICH_PRESENCE_BUTTON_MODAL_CUSTOM_ID,
		components: [
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Texto do botao',
				description: 'Opcional. Deixe vazio para remover o botao.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_BUTTON_LABEL_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 80,
					required: false,
					placeholder: 'Abrir site',
					value: config.buttonLabel,
				},
			},
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'URL do botao',
				description:
					'Necessaria para botao. Em Transmitindo, tambem vira URL da live.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_BUTTON_URL_INPUT_CUSTOM_ID,
					style: TextInputStyle.Short,
					max_length: 512,
					required: false,
					placeholder: 'https://exemplo.com',
					value: config.buttonUrl,
				},
			},
		],
	} as any;
}

function buildRichPresenceImageUploadModal(
	customId: string,
	title: string,
	uploadCustomId: string,
) {
	return {
		title,
		custom_id: customId,
		components: [
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Galeria (upload)',
				description: 'Envie 1 imagem/gif (PNG/JPG/GIF/WEBP).',
				component: {
					type: MODAL_FILE_UPLOAD_COMPONENT_TYPE,
					custom_id: uploadCustomId,
					min_values: 1,
					max_values: 1,
					required: true,
				},
			},
		],
	} as any;
}

function buildRichPresenceImagesModal(
	config: RichPresenceRuntimeConfig = {},
) {
	return {
		title: 'Editar URLs das imagens',
		custom_id: RICH_PRESENCE_IMAGES_MODAL_CUSTOM_ID,
		components: [
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Imagem grande - URL ou asset',
				description: 'Ex: https://cdn.discordapp.com/icons/.../icone.gif',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_LARGE_IMAGE_URL_INPUT_CUSTOM_ID,
					style: TextInputStyle.Paragraph,
					max_length: 1024,
					required: false,
					value: config.largeImage,
				},
			},
			{
				type: MODAL_LABEL_COMPONENT_TYPE,
				label: 'Imagem pequena - URL ou asset',
				description: 'Use uma URL publica ou uma chave de asset do app.',
				component: {
					type: ComponentType.TextInput,
					custom_id: RICH_SMALL_IMAGE_URL_INPUT_CUSTOM_ID,
					style: TextInputStyle.Paragraph,
					max_length: 1024,
					required: false,
					value: config.smallImage,
				},
			},
		],
	} as any;
}

function buildVoiceConfigModal(record?: Awaited<ReturnType<typeof panelStore.getUser>>) {
	return {
		title: 'Configurar Voice Session',
		custom_id: VOICE_CONFIG_MODAL_CUSTOM_ID,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: VOICE_GUILD_ID_INPUT_CUSTOM_ID,
						label: 'ID do servidor',
						style: TextInputStyle.Short,
						min_length: 10,
						max_length: 32,
						required: true,
						placeholder: 'Cole o ID do servidor.',
						value: record?.voiceGuildId,
					},
				],
			},
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: VOICE_CHANNEL_ID_INPUT_CUSTOM_ID,
						label: 'ID do canal de voz',
						style: TextInputStyle.Short,
						min_length: 10,
						max_length: 32,
						required: true,
						placeholder: 'Cole o ID do canal de voz.',
						value: record?.voiceChannelId,
					},
				],
			},
		],
	} as any;
}

function buildUsernameCheckerConfigModal(
	record?: Awaited<ReturnType<typeof panelStore.getUser>>,
) {
	const options = record?.usernameCheckerOptions ?? {};

	return {
		title: 'Configurar Username Checker',
		custom_id: USERNAME_CHECKER_CONFIG_MODAL_CUSTOM_ID,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: USERNAME_LENGTH_INPUT_CUSTOM_ID,
						label: 'Tamanho do username',
						style: TextInputStyle.Short,
						min_length: 1,
						max_length: 2,
						required: true,
						placeholder: '4',
						value: String(options.usernameLength ?? 4),
					},
				],
			},
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: USERNAME_CONCURRENCY_INPUT_CUSTOM_ID,
						label: 'Concorrencia',
						style: TextInputStyle.Short,
						min_length: 1,
						max_length: 3,
						required: false,
						placeholder: 'Auto',
						value:
							options.concurrency === undefined
								? undefined
								: String(options.concurrency),
					},
				],
			},
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: USERNAME_REQUEST_DELAY_INPUT_CUSTOM_ID,
						label: 'Delay entre requests (ms)',
						style: TextInputStyle.Short,
						min_length: 1,
						max_length: 5,
						required: true,
						placeholder: '2000',
						value: String(options.requestDelay ?? 2000),
					},
				],
			},
		],
	} as any;
}

async function registerCommands(ready: GatewayReadyDispatchData) {
	applicationId = applicationId || ready.application?.id || ready.user.id;
	const commands = [
		{
			name: PANEL_COMMAND_NAME,
			description: 'Create the public automation panel.',
			type: ApplicationCommandType.ChatInput,
		},
	] as any;

	if (guildId) {
		await client.api.applicationCommands.bulkOverwriteGuildCommands(
			applicationId,
			guildId,
			commands,
		);
		console.log(`Registered /${PANEL_COMMAND_NAME} for guild ${guildId}.`);
		return;
	}

	await client.api.applicationCommands.bulkOverwriteGlobalCommands(
		applicationId,
		commands,
	);
	console.log(`Registered global /${PANEL_COMMAND_NAME}.`);
}

async function replyEphemeral(interaction: APIInteraction, message: string) {
	await client.api.interactions.reply(interaction.id, interaction.token, {
		content: message,
		flags: MessageFlags.Ephemeral as any,
	} as any);
	acknowledgedInteractions.add(interaction.id);
}

async function deferEphemeralReply(interaction: APIInteraction) {
	await client.api.interactions.defer(
		interaction.id,
		interaction.token,
		{
			flags: MessageFlags.Ephemeral as any,
		} as any,
	);
	deferredReplies.add(interaction.id);
	acknowledgedInteractions.add(interaction.id);
}

async function tryDeferEphemeralReply(
	interaction: APIInteraction,
): Promise<boolean> {
	try {
		await deferEphemeralReply(interaction);
		return true;
	} catch (error) {
		if (isExpiredOrAcknowledgedInteraction(error)) {
			return false;
		}

		throw error;
	}
}

async function editEphemeralReply(interaction: APIInteraction, message: string) {
	await client.api.interactions.editReply(
		applicationId,
		interaction.token,
		{
			content: message,
		} as any,
	);
	deferredReplies.delete(interaction.id);
}

async function followUpEphemeral(interaction: APIInteraction, message: string) {
	await client.api.interactions.followUp(applicationId, interaction.token, {
		content: message,
		flags: MessageFlags.Ephemeral as any,
	} as any);
}

async function safeReplyEphemeral(
	interaction: APIInteraction,
	message: string,
) {
	try {
		if (deferredReplies.has(interaction.id)) {
			await editEphemeralReply(interaction, message);
			return;
		}

		if (acknowledgedInteractions.has(interaction.id)) {
			await followUpEphemeral(interaction, message);
			return;
		}

		await replyEphemeral(interaction, message);
	} catch (error) {
		if (isExpiredOrAcknowledgedInteraction(error)) {
			return;
		}

		console.error('Failed to send interaction reply:', error);
	}
}

async function deferComponent(interaction: APIInteraction) {
	await client.api.interactions.deferMessageUpdate(
		interaction.id,
		interaction.token,
	);
	acknowledgedInteractions.add(interaction.id);
}

async function tryDeferComponent(interaction: APIInteraction): Promise<boolean> {
	try {
		await deferComponent(interaction);
		return true;
	} catch (error) {
		if (isExpiredOrAcknowledgedInteraction(error)) {
			return false;
		}

		throw error;
	}
}

async function openTokenModal(interaction: APIInteraction, customId: string) {
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildTokenModal(customId),
	);
}

async function openTokenModalIfNeeded(
	interaction: APIInteraction,
	customId: string,
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (await tokenStore.has(userId)) {
		await safeReplyEphemeral(interaction, 'Token ja configurado.');
		return;
	}

	await openTokenModal(interaction, customId);
}

async function openClearTargetUserModal(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildClearTargetUserModal(record),
	);
}

function isDiscordId(value: string): boolean {
	return /^\d{10,32}$/.test(value);
}

async function handleSetClearBulkMode(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	await createPanels(userId).updateClearPanel({
		clearMode: 'bulk',
		clearTargetUserId: undefined,
		currentMission: 'Modo em massa selecionado.',
	});
}

async function handleClearTargetUserModal(
	interaction: APIModalSubmitInteraction,
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const targetUserId = getModalValue(
		interaction,
		CLEAR_TARGET_USER_ID_INPUT_CUSTOM_ID,
	)?.trim();

	if (!targetUserId || !isDiscordId(targetUserId)) {
		await safeReplyEphemeral(interaction, 'User ID invalido.');
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;
	await createPanels(userId).updateClearPanel({
		clearMode: 'userDm',
		clearTargetUserId: targetUserId,
		currentMission: `DM especifica configurada: ${targetUserId}.`,
	});
	await editEphemeralReply(
		interaction,
		`Clean System configurado para limpar a DM de ${targetUserId} e remover o contato.`,
	);
}

async function resetMainPanelSelection(interaction: APIInteraction) {
	const channelId = getInteractionChannelId(interaction);
	const messageId = getInteractionMessageId(interaction);
	if (!channelId || !messageId) return;

	try {
		await client.api.channels.editMessage(
			channelId,
			messageId,
			buildMainPanelPayload() as any,
		);
	} catch (error) {
		console.error('Could not reset main panel select menu:', error);
	}
}

function panelOptionsFromGuilds(
	guilds: Awaited<ReturnType<typeof fetchDiscordGuildOptions>>,
): PanelSelectOption[] {
	return guilds.map((guild) => ({
		label: guild.name,
		value: guild.id,
		description: guild.id,
	}));
}

function panelOptionsFromChannels(
	channels: Awaited<ReturnType<typeof fetchDiscordVoiceChannelOptions>>,
): PanelSelectOption[] {
	return channels.map((channel) => ({
		label: channel.name,
		value: channel.id,
		description: channel.id,
	}));
}

async function buildVoicePanelOptions(
	userId: string,
	record?: Awaited<ReturnType<typeof panelStore.getUser>>,
): Promise<{
	guildOptions: PanelSelectOption[];
	channelOptions: PanelSelectOption[];
}> {
	const currentRecord = record ?? (await panelStore.getUser(userId));
	const token = await getValidUserToken(userId);
	if (!token) {
		return {
			guildOptions: [],
			channelOptions: [],
		};
	}

	const guildOptions = panelOptionsFromGuilds(
		await fetchDiscordGuildOptions(token),
	);
	const channelOptions = currentRecord.voiceGuildId
		? panelOptionsFromChannels(
			await fetchDiscordVoiceChannelOptions(token, currentRecord.voiceGuildId),
		)
		: [];

	return { guildOptions, channelOptions };
}

async function refreshVoicePanel(
	userId: string,
	patch: Partial<Awaited<ReturnType<typeof panelStore.getUser>>> = {},
) {
	const nextRecord = {
		...(await panelStore.getUser(userId)),
		...patch,
	};
	const { guildOptions, channelOptions } = await buildVoicePanelOptions(
		userId,
		nextRecord,
	);

	return createPanels(userId).updateVoicePanel(
		patch,
		guildOptions,
		channelOptions,
	);
}

function getVoiceSession(userId: string, token: string): DiscordVoiceSession {
	const existing = voiceSessions.get(userId);
	if (existing?.token === token) return existing.session;

	existing?.session.stop();
	const session = new DiscordVoiceSession(token, (update) => {
		void refreshVoicePanel(userId, {
			voiceStatus: update.status,
			voiceConnectedAt: update.connectedAt,
		});
	});
	voiceSessions.set(userId, { token, session });
	return session;
}

function getRichPresenceSession(
	userId: string,
	token: string,
): DiscordRichPresenceSession {
	const existing = richPresenceSessions.get(userId);
	if (existing?.token === token) return existing.session;

	existing?.session.stop();
	const session = new DiscordRichPresenceSession(
		token,
		(status) => {
			void createPanels(userId).updateRichPresencePanel({
				richPresenceStatus: status,
				richPresenceUpdatedAt: new Date().toISOString(),
			});
		},
		richPresenceApplicationId || undefined,
	);
	richPresenceSessions.set(userId, { token, session });
	return session;
}

async function updateMissionRichPresence(
	userId: string,
	token: string,
	runVersion: number,
	gameName?: string,
): Promise<void> {
	const normalizedGameName = gameName?.trim();
	if (!normalizedGameName || !isCurrentMissionRun(userId, runVersion)) return;

	let snapshot = missionRichPresenceSnapshots.get(userId);
	if (!snapshot || snapshot.runVersion !== runVersion) {
		const record = await panelStore.getUser(userId);
		snapshot = {
			runVersion,
			wasActive: record.richPresenceStatus === 'active',
			config: { ...record.richPresenceConfig },
		};
		missionRichPresenceSnapshots.set(userId, snapshot);
	}

	if (snapshot.lastGame === normalizedGameName) return;
	snapshot.lastGame = normalizedGameName;

	getRichPresenceSession(userId, token).update({
		activityType: 0,
		name: normalizedGameName,
		details: 'Executando missao',
		state: 'Jogando pelo sistema de missoes',
		startTimestamp: new Date().toISOString(),
	});
}

async function restoreMissionRichPresence(
	userId: string,
	token: string,
	runVersion: number,
): Promise<void> {
	const snapshot = missionRichPresenceSnapshots.get(userId);
	if (!snapshot || snapshot.runVersion !== runVersion) return;

	missionRichPresenceSnapshots.delete(userId);
	const session = getRichPresenceSession(userId, token);
	if (snapshot.wasActive) {
		session.update(snapshot.config);
		return;
	}

	session.stop();
	richPresenceSessions.delete(userId);
}

function parseOptionalModalValue(
	interaction: APIModalSubmitInteraction,
	customId: string,
): string | undefined {
	return getModalValue(interaction, customId)?.trim() || undefined;
}

function parseSubmittedOptionalModalValue(
	interaction: APIModalSubmitInteraction,
	customId: string,
	previousValue?: string,
): string | undefined {
	const component = findModalComponent(interaction, customId);
	if (!component || typeof component.value !== 'string') return previousValue;

	return component.value.trim() || undefined;
}

function getResolvedModalAttachment(
	interaction: APIModalSubmitInteraction,
	attachmentId: string,
): ModalAttachmentPayload | undefined {
	const attachments = ((interaction.data as any).resolved?.attachments ??
		{}) as
		| Record<string, ModalAttachmentPayload>
		| Map<string, ModalAttachmentPayload>;

	if (attachments instanceof Map) return attachments.get(attachmentId);
	if (typeof (attachments as any).get === 'function') {
		return (attachments as any).get(attachmentId);
	}

	return (attachments as Record<string, ModalAttachmentPayload>)[attachmentId];
}

function getUploadedModalImage(
	interaction: APIModalSubmitInteraction,
	customId: string,
): ModalAttachmentPayload | undefined {
	const component = findModalComponent(interaction, customId);
	const attachmentId = component?.values?.[0];
	if (!attachmentId) return undefined;

	const attachment = getResolvedModalAttachment(interaction, attachmentId);
	if (!attachment) return undefined;

	if (
		attachment.content_type &&
		!attachment.content_type.toLowerCase().startsWith('image/')
	) {
		return undefined;
	}

	return attachment;
}

async function uploadRichPresenceImageToDm(
	userId: string,
	attachment: ModalAttachmentPayload,
	fallbackName: string,
): Promise<string> {
	const sourceUrl = attachment.url || attachment.proxy_url;
	if (!sourceUrl) {
		throw new Error('Upload de imagem sem URL resolvida.');
	}

	const response = await fetch(sourceUrl);
	if (!response.ok) {
		throw new Error(`Falha ao baixar imagem enviada (${response.status}).`);
	}

	const contentType =
		attachment.content_type || response.headers.get('content-type') || '';
	if (contentType && !contentType.toLowerCase().startsWith('image/')) {
		throw new Error('O arquivo enviado nao parece ser uma imagem.');
	}

	if (!richPresenceAssetChannelId) {
		throw new Error(
			'Configure RICH_PRESENCE_ASSET_CHANNEL_ID no .env para salvar imagens sem aparecer na sua DM.',
		);
	}

	const targetChannelId = richPresenceAssetChannelId;
	const buffer = Buffer.from(await response.arrayBuffer());
	const message = (await client.api.channels.createMessage(targetChannelId, {
		content: 'Imagem salva para Rich Presence.',
		files: [
			{
				name: attachment.filename || fallbackName,
				data: buffer,
			},
		],
	} as any)) as any;

	const uploadedAttachment = message.attachments?.[0];
	const uploadedUrl = uploadedAttachment?.url || uploadedAttachment?.proxy_url;
	if (!uploadedUrl) {
		throw new Error('Discord nao retornou URL do anexo re-hospedado.');
	}

	return uploadedUrl;
}

async function uploadRichPresenceImagesToDm(
	userId: string,
	interaction: APIModalSubmitInteraction,
): Promise<UploadedRichPresenceImages> {
	const largeImage = getUploadedModalImage(
		interaction,
		RICH_LARGE_IMAGE_UPLOAD_CUSTOM_ID,
	);
	const smallImage = getUploadedModalImage(
		interaction,
		RICH_SMALL_IMAGE_UPLOAD_CUSTOM_ID,
	);

	return {
		largeImage: largeImage
			? await uploadRichPresenceImageToDm(
				userId,
				largeImage,
				'rich-presence-large-image.png',
			)
			: undefined,
		smallImage: smallImage
			? await uploadRichPresenceImageToDm(
				userId,
				smallImage,
				'rich-presence-small-image.png',
			)
			: undefined,
	};
}

function parseRichPresenceConfig(
	interaction: APIModalSubmitInteraction,
	previousConfig: RichPresenceRuntimeConfig = {},
): RichPresenceRuntimeConfig {
	return {
		...previousConfig,
		name: parseOptionalModalValue(
			interaction,
			RICH_ACTIVITY_NAME_INPUT_CUSTOM_ID,
		),
		description: parseSubmittedOptionalModalValue(
			interaction,
			RICH_DESCRIPTION_INPUT_CUSTOM_ID,
			previousConfig.description,
		),
		state: parseSubmittedOptionalModalValue(
			interaction,
			RICH_STATE_INPUT_CUSTOM_ID,
			previousConfig.state,
		),
		details: parseSubmittedOptionalModalValue(
			interaction,
			RICH_DETAILS_INPUT_CUSTOM_ID,
			previousConfig.details,
		),
		largeText: parseSubmittedOptionalModalValue(
			interaction,
			RICH_LARGE_IMAGE_TEXT_INPUT_CUSTOM_ID,
			previousConfig.largeText,
		),
	};
}

function parseRichPresenceStartTimestamp(value?: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (['agora', 'now'].includes(trimmed.toLowerCase())) {
		return new Date().toISOString();
	}

	const brDate = trimmed.match(
		/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
	);
	if (brDate) {
		const [, day, month, year, hour = '00', minute = '00', second = '00'] =
			brDate;
		const parsed = new Date(
			Number(year),
			Number(month) - 1,
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
		);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
	}

	const parsed = new Date(trimmed);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parseRichPresenceAdvancedConfig(
	interaction: APIModalSubmitInteraction,
	previousConfig: RichPresenceRuntimeConfig = {},
): RichPresenceRuntimeConfig {
	const startTime = parseSubmittedOptionalModalValue(
		interaction,
		RICH_START_TIME_INPUT_CUSTOM_ID,
		previousConfig.startTimestamp,
	);

	return {
		...previousConfig,
		applicationId: parseSubmittedOptionalModalValue(
			interaction,
			RICH_APPLICATION_ID_INPUT_CUSTOM_ID,
			previousConfig.applicationId,
		),
		startTimestamp: parseRichPresenceStartTimestamp(startTime),
	};
}

function parseRichPresenceButtonConfig(
	interaction: APIModalSubmitInteraction,
	previousConfig: RichPresenceRuntimeConfig = {},
): RichPresenceRuntimeConfig {
	return {
		...previousConfig,
		buttonLabel: parseSubmittedOptionalModalValue(
			interaction,
			RICH_BUTTON_LABEL_INPUT_CUSTOM_ID,
			previousConfig.buttonLabel,
		),
		buttonUrl: parseSubmittedOptionalModalValue(
			interaction,
			RICH_BUTTON_URL_INPUT_CUSTOM_ID,
			previousConfig.buttonUrl,
		),
	};
}

function parseRichPresenceImagesConfig(
	interaction: APIModalSubmitInteraction,
	previousConfig: RichPresenceRuntimeConfig = {},
): RichPresenceRuntimeConfig {
	return {
		...previousConfig,
		largeImage: parseSubmittedOptionalModalValue(
			interaction,
			RICH_LARGE_IMAGE_URL_INPUT_CUSTOM_ID,
			previousConfig.largeImage,
		),
		smallImage: parseSubmittedOptionalModalValue(
			interaction,
			RICH_SMALL_IMAGE_URL_INPUT_CUSTOM_ID,
			previousConfig.smallImage,
		),
	};
}

function parseRichPresenceActivityType(
	value: string | null,
): RichPresenceActivityType | null {
	switch (value) {
		case '0':
			return 0;
		case '1':
			return 1;
		case '2':
			return 2;
		case '3':
			return 3;
		case '5':
			return 5;
		default:
			return null;
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

function validateRichPresenceConfig(
	config: RichPresenceRuntimeConfig,
): string | null {
	if (!config.name) return 'Nome da atividade e obrigatorio.';
	if (config.activityType === 1 && !isSupportedStreamingUrl(config.buttonUrl)) {
		return 'Transmitindo precisa de uma URL da Twitch ou YouTube.';
	}

	const needsApplicationId = Boolean(config.largeImage) || Boolean(config.smallImage);
	if (needsApplicationId && !(config.applicationId || richPresenceApplicationId)) {
		return 'Para imagens aparecerem, preencha o ID do app em Avancado.';
	}

	return null;
}

async function handleMainPanelCommand(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	const channelId = getInteractionChannelId(interaction);

	if (!userId || !channelId) {
		await safeReplyEphemeral(interaction, 'Could not identify this channel.');
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;
	await createPanels(userId).ensureMainPanel(channelId);
	await editEphemeralReply(
		interaction,
		'Main panel sent/updated in this channel.',
	);
}

async function sendDmPanel(
	interaction: APIInteraction,
	type: 'clear' | 'mission' | 'voice' | 'richPresence' | 'usernameChecker',
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;

	const panels = createPanels(userId);
	try {
		if (type === 'clear') {
			await panels.ensureClearPanel();
		} else if (type === 'mission') {
			await panels.ensureMissionPanel();
		} else if (type === 'voice') {
			const { guildOptions, channelOptions } = await buildVoicePanelOptions(
				userId,
			);
			await panels.ensureVoicePanel(guildOptions, channelOptions);
		} else if (type === 'richPresence') {
			await panels.ensureRichPresencePanel();
		} else {
			await panels.ensureUsernameCheckerPanel();
		}
		await editEphemeralReply(interaction, 'Panel sent/updated in your DM.');
	} catch (error) {
		console.error(`Could not send ${type} panel by DM:`, error);
		await safeReplyEphemeral(
			interaction,
			'I could not open your DM. Enable direct messages from this server and try again.',
		);
	}
}

async function deleteBotDmPanels(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;

	await editEphemeralReply(
		interaction,
		'Limpeza da DM do bot iniciada.',
	);

	void (async () => {
		try {
			const deletedCount = await createPanels(userId).deleteBotDmMessages();
			await safeReplyEphemeral(
				interaction,
				deletedCount > 0
					? 'Bot DM messages deleted.'
					: 'No bot DM messages were found for your user.',
			);
		} catch (error) {
			console.error('Could not delete bot DM messages:', error);
			await safeReplyEphemeral(
				interaction,
				'Could not finish bot DM cleanup.',
			);
		}
	})();
}

async function handleVoiceGuildSelect(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	const guildId = getSelectedValue(interaction);
	if (!userId || !guildId) {
		await safeReplyEphemeral(interaction, 'Could not identify the selection.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;

	const token = await getValidUserToken(userId);
	if (!token) {
		await refreshVoicePanel(userId, { tokenConfigured: false });
		return;
	}

	const guilds = await fetchDiscordGuildOptions(token);
	const guild = guilds.find((item) => item.id === guildId);
	await refreshVoicePanel(userId, {
		voiceGuildId: guildId,
		voiceGuildName: guild?.name ?? guildId,
		voiceChannelId: undefined,
		voiceChannelName: undefined,
		tokenConfigured: true,
	});
}

async function handleVoiceChannelSelect(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	const channelId = getSelectedValue(interaction);
	if (!userId || !channelId) {
		await safeReplyEphemeral(interaction, 'Could not identify the selection.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;

	const token = await getValidUserToken(userId);
	const record = await panelStore.getUser(userId);
	if (!token || !record.voiceGuildId) {
		await refreshVoicePanel(userId, { tokenConfigured: Boolean(token) });
		return;
	}

	const channels = await fetchDiscordVoiceChannelOptions(
		token,
		record.voiceGuildId,
	);
	const channel = channels.find((item) => item.id === channelId);
	await refreshVoicePanel(userId, {
		voiceChannelId: channelId,
		voiceChannelName: channel?.name ?? channelId,
		tokenConfigured: true,
	});
}

async function handleStartVoice(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tokenStore.has(userId))) {
		await openTokenModal(interaction, VOICE_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	const record = await panelStore.getUser(userId);
	if (!record.voiceGuildId || !record.voiceChannelId) {
		await openVoiceConfigModal(interaction);
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	const token = await requireValidTokenAfterAck(interaction, userId);
	if (!token) return;

	getVoiceSession(userId, token).start(
		record.voiceGuildId,
		record.voiceChannelId,
	);
	await refreshVoicePanel(userId, {
		tokenConfigured: true,
		voiceStatus: 'reconnecting',
	});
}

async function handleChangeVoiceChannel(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tokenStore.has(userId))) {
		await openTokenModal(interaction, VOICE_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	const record = await panelStore.getUser(userId);
	if (!record.voiceGuildId || !record.voiceChannelId) {
		await openVoiceConfigModal(interaction);
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	const token = await requireValidTokenAfterAck(interaction, userId);
	if (!token) return;

	getVoiceSession(userId, token).changeChannel(
		record.voiceGuildId,
		record.voiceChannelId,
	);
	await refreshVoicePanel(userId, {
		tokenConfigured: true,
		voiceStatus: 'connected',
	});
}

async function handleStopVoice(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	voiceSessions.get(userId)?.session.stop();
	voiceSessions.delete(userId);
	await refreshVoicePanel(userId, {
		voiceStatus: 'disconnected',
		voiceConnectedAt: undefined,
	});
}

async function openRichPresenceConfigModal(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildRichPresenceConfigModal(record.richPresenceConfig),
	);
}

async function openRichPresenceButtonModal(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildRichPresenceButtonModal(record.richPresenceConfig),
	);
}

async function openRichPresenceAdvancedModal(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildRichPresenceAdvancedModal(record.richPresenceConfig),
	);
}

async function openRichPresenceLargeImageModal(interaction: APIInteraction) {
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildRichPresenceImageUploadModal(
			RICH_PRESENCE_LARGE_IMAGE_MODAL_CUSTOM_ID,
			'Selecionar imagem grande',
			RICH_LARGE_IMAGE_UPLOAD_CUSTOM_ID,
		),
	);
}

async function openRichPresenceSmallImageModal(interaction: APIInteraction) {
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildRichPresenceImageUploadModal(
			RICH_PRESENCE_SMALL_IMAGE_MODAL_CUSTOM_ID,
			'Selecionar imagem pequena',
			RICH_SMALL_IMAGE_UPLOAD_CUSTOM_ID,
		),
	);
}

async function openRichPresenceImagesModal(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildRichPresenceImagesModal(record.richPresenceConfig),
	);
}

async function openVoiceConfigModal(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildVoiceConfigModal(record),
	);
}

async function openUsernameCheckerConfigModal(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (usernameCheckerSessions.has(userId)) {
		await safeReplyEphemeral(
			interaction,
			'Pare o Username Checker antes de alterar a configuracao.',
		);
		return;
	}

	const record = await panelStore.getUser(userId);
	await client.api.interactions.createModal(
		interaction.id,
		interaction.token,
		buildUsernameCheckerConfigModal(record),
	);
}

function emptyUsernameCheckerStats(): CheckerStats {
	return {
		hits: 0,
		taken: 0,
		errors: 0,
		deadProxies: 0,
		activeProxies: 0,
		bannedProxies: 0,
		workersRunning: 0,
	};
}

function parseIntegerModalValue(
	interaction: APIModalSubmitInteraction,
	customId: string,
	label: string,
	min: number,
	max: number,
	required: boolean,
): number | undefined {
	const rawValue = getModalValue(interaction, customId)?.trim();
	if (!rawValue) {
		if (required) {
			throw new Error(`${label} e obrigatorio.`);
		}
		return undefined;
	}

	const value = Number(rawValue);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${label} precisa ser um numero entre ${min} e ${max}.`);
	}

	return value;
}

function parseUsernameCheckerOptions(
	interaction: APIModalSubmitInteraction,
): CheckerOptions {
	return {
		usernameLength: parseIntegerModalValue(
			interaction,
			USERNAME_LENGTH_INPUT_CUSTOM_ID,
			'Tamanho do username',
			2,
			20,
			true,
		),
		concurrency: parseIntegerModalValue(
			interaction,
			USERNAME_CONCURRENCY_INPUT_CUSTOM_ID,
			'Concorrencia',
			1,
			200,
			false,
		),
		requestDelay: parseIntegerModalValue(
			interaction,
			USERNAME_REQUEST_DELAY_INPUT_CUSTOM_ID,
			'Delay entre requests',
			1500,
			60000,
			true,
		),
	};
}

async function updateUsernameCheckerPanel(
	userId: string,
	patch: Partial<Awaited<ReturnType<typeof panelStore.getUser>>>,
) {
	return createPanels(userId).updateUsernameCheckerPanel({
		...patch,
		usernameCheckerUpdatedAt: new Date().toISOString(),
	});
}

function rememberUsernameCheckerEvent(
	checker: DiscordUsernameChecker,
	setLastEvent: (message: string) => void,
) {
	checker.on('hit', (username: string) => {
		setLastEvent(`Hit encontrado: ${username}`);
	});
	checker.on('taken', (username: string) => {
		setLastEvent(`Username ocupado: ${username}`);
	});
	checker.on('proxy:banned', (proxy: string) => {
		setLastEvent(`Proxy limitado e banido: ${proxy}`);
	});
	checker.on('proxy:dead', (proxy: string) => {
		setLastEvent(`Proxy morto: ${proxy}`);
	});
	checker.on('proxy:restored', (count: number) => {
		setLastEvent(`${count} proxy(s) restaurado(s).`);
	});
	checker.on('ratelimit', (ctx: { proxy: string }) => {
		setLastEvent(`Rate limit no proxy: ${ctx.proxy}`);
	});
}

async function handleStartUsernameChecker(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (usernameCheckerSessions.has(userId)) {
		await safeReplyEphemeral(interaction, 'Username Checker ja esta rodando.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;

	const record = await panelStore.getUser(userId);
	const options = record.usernameCheckerOptions;
	const checker = new DiscordUsernameChecker();
	usernameCheckerSessions.set(userId, checker);

	let lastEvent = 'Username Checker iniciado.';
	let finalStatus: PanelSystemStatus = 'completed';
	const setLastEvent = (message: string) => {
		lastEvent = message;
	};
	const publish = async (
		patch: Partial<Awaited<ReturnType<typeof panelStore.getUser>>>,
	) => {
		try {
			await updateUsernameCheckerPanel(userId, patch);
		} catch (error) {
			console.error('Could not update Username Checker panel:', error);
		}
	};

	rememberUsernameCheckerEvent(checker, setLastEvent);
	checker.on('error', (ctx: { username?: string; workerId?: number; message: string }) => {
		setLastEvent(ctx.message);
		if (!ctx.username && ctx.workerId === 0) {
			finalStatus = 'error';
			void publish({
				usernameCheckerStatus: 'error',
				usernameCheckerStats: checker.getStats(),
				usernameCheckerLastEvent: lastEvent,
			});
		}
	});
	checker.on('stats', (stats: CheckerStats) => {
		void publish({
			usernameCheckerStatus: 'running',
			usernameCheckerStats: stats,
			usernameCheckerLastEvent: lastEvent,
		});
	});
	checker.once('stopped', () => {
		if (finalStatus !== 'error') {
			finalStatus = 'deactivated';
			setLastEvent('Username Checker parado pelo usuario.');
		}
	});
	checker.once('done', () => {
		if (finalStatus !== 'error') {
			finalStatus = 'completed';
			setLastEvent('Username Checker finalizado.');
		}
	});

	await publish({
		usernameCheckerStatus: 'running',
		usernameCheckerOptions: options,
		usernameCheckerStats: emptyUsernameCheckerStats(),
		usernameCheckerLastEvent: lastEvent,
	});

	void checker
		.start(options)
		.catch((error: unknown) => {
			finalStatus = 'error';
			setLastEvent(error instanceof Error ? error.message : String(error));
		})
		.finally(() => {
			if (usernameCheckerSessions.get(userId) === checker) {
				usernameCheckerSessions.delete(userId);
			}
			void publish({
				usernameCheckerStatus: finalStatus,
				usernameCheckerStats: checker.getStats(),
				usernameCheckerLastEvent: lastEvent,
			});
		});
}

async function handleStopUsernameChecker(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;

	const checker = usernameCheckerSessions.get(userId);
	if (!checker) {
		await updateUsernameCheckerPanel(userId, {
			usernameCheckerStatus: 'inactive',
			usernameCheckerLastEvent: 'Nenhum Username Checker em execucao.',
		});
		return;
	}

	await checker.stop();
	await updateUsernameCheckerPanel(userId, {
		usernameCheckerStatus: 'deactivated',
		usernameCheckerStats: checker.getStats(),
		usernameCheckerLastEvent: 'Parada solicitada. Finalizando workers...',
	});
}

async function handleUsernameCheckerConfigModal(
	interaction: APIModalSubmitInteraction,
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (usernameCheckerSessions.has(userId)) {
		await safeReplyEphemeral(
			interaction,
			'Pare o Username Checker antes de alterar a configuracao.',
		);
		return;
	}

	let options: CheckerOptions;
	try {
		options = parseUsernameCheckerOptions(interaction);
	} catch (error) {
		await safeReplyEphemeral(
			interaction,
			error instanceof Error ? error.message : String(error),
		);
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;

	await updateUsernameCheckerPanel(userId, {
		usernameCheckerOptions: options,
		usernameCheckerLastEvent: 'Configuracao atualizada.',
	});
	await editEphemeralReply(
		interaction,
		'Username Checker configuration updated.',
	);
}

async function applyVoiceManualConfig(
	userId: string,
	token: string,
	guildId: string,
	channelId: string,
) {
	const guilds = await fetchDiscordGuildOptions(token);
	const guild = guilds.find((item) => item.id === guildId);
	const channels = await fetchDiscordVoiceChannelOptions(token, guildId);
	const channel = channels.find((item) => item.id === channelId);

	return refreshVoicePanel(userId, {
		tokenConfigured: true,
		voiceGuildId: guildId,
		voiceGuildName: guild?.name ?? guildId,
		voiceChannelId: channelId,
		voiceChannelName: channel?.name ?? channelId,
	});
}

async function handleStartRichPresence(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tokenStore.has(userId))) {
		await openTokenModal(interaction, RICH_PRESENCE_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	const record = await panelStore.getUser(userId);
	const validationError = validateRichPresenceConfig(record.richPresenceConfig);
	if (validationError === 'Nome da atividade e obrigatorio.') {
		await openRichPresenceConfigModal(interaction);
		return;
	}
	if (validationError) {
		await safeReplyEphemeral(interaction, validationError);
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	const token = await requireValidTokenAfterAck(interaction, userId);
	if (!token) return;

	getRichPresenceSession(userId, token).start(record.richPresenceConfig);
	await createPanels(userId).updateRichPresencePanel({
		tokenConfigured: true,
		richPresenceStatus: 'active',
		richPresenceUpdatedAt: new Date().toISOString(),
	});
}

async function handleApplyRichPresence(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tokenStore.has(userId))) {
		await openTokenModal(interaction, RICH_PRESENCE_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	const record = await panelStore.getUser(userId);
	const validationError = validateRichPresenceConfig(record.richPresenceConfig);
	if (validationError === 'Nome da atividade e obrigatorio.') {
		await openRichPresenceConfigModal(interaction);
		return;
	}
	if (validationError) {
		await safeReplyEphemeral(interaction, validationError);
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	const token = await requireValidTokenAfterAck(interaction, userId);
	if (!token) return;

	getRichPresenceSession(userId, token).update(record.richPresenceConfig);
	await createPanels(userId).updateRichPresencePanel({
		tokenConfigured: true,
		richPresenceStatus: 'active',
		richPresenceUpdatedAt: new Date().toISOString(),
	});
}

async function handleStopRichPresence(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	richPresenceSessions.get(userId)?.session.stop();
	richPresenceSessions.delete(userId);
	await createPanels(userId).updateRichPresencePanel({
		richPresenceStatus: 'inactive',
		richPresenceUpdatedAt: new Date().toISOString(),
	});
}

async function handleResetRichPresence(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	richPresenceSessions.get(userId)?.session.stop();
	richPresenceSessions.delete(userId);
	await createPanels(userId).updateRichPresencePanel({
		richPresenceConfig: {},
		richPresenceStatus: 'inactive',
		richPresenceUpdatedAt: new Date().toISOString(),
	});
}

async function queueMissionRun(userId: string) {
	const token = await getValidUserToken(userId);
	const panels = createPanels(userId);
	const record = await panelStore.getUser(userId);

	if (!token) {
		await panels.updateMissionPanel({
			tokenConfigured: false,
			missionStatus: 'waiting',
			currentMission: 'Aguardando configuracao do token.',
			progress: 0,
		});
		throw new Error('Token is not configured.');
	}

	let currentRecord = await panels.updateMissionPanel({
		tokenConfigured: true,
		missionStatus: 'active',
		currentMission: 'Usando token salvo.',
		completedCount: 0,
		totalMissions: 0,
		progress: 0,
	});
	const runVersion = nextMissionRunVersion(userId);

	missionQueue.enqueue({
		userId,
		onQueued: async (position) => {
			activateMissionRun(userId, runVersion);
			currentRecord = await panels.updateMissionPanel({
				missionStatus: 'waiting',
				progress: 0,
				currentMission:
					position > 1
						? `Aguardando na fila. Posicao ${position}.`
						: 'Fazendo missoes pendentes, aguarde...',
			});
		},
		onRejected: async (reason) => {
			await panels.updateMissionPanel({
				missionStatus: 'error',
				currentMission: reason,
				progress: 0,
			});
		},
		onCancelled: async (reason) => {
			invalidateMissionRun(userId);
			await panels.updateMissionPanel({
				missionStatus: 'inactive',
				currentMission: reason,
				progress: 0,
			});
		},
		run: async (signal) => {
			const shouldUpdateMissionPanel = () =>
				!signal.aborted && isCurrentMissionRun(userId, runVersion);

			try {
				await runMissionFlow(
					token,
					async (update) => {
						if (!shouldUpdateMissionPanel()) return;

						if (
							update.state === 'Running' &&
							update.currentMission
						) {
							await updateMissionRichPresence(
								userId,
								token,
								runVersion,
								update.currentMission,
							);
						}

						const updatedRecord = await panels.updateMissionPanel(
							mapMissionStatusToPanel(update, currentRecord),
						);
						if (shouldUpdateMissionPanel()) {
							currentRecord = updatedRecord;
						}
					},
					signal,
					record.missionConcurrency,
				);
			} catch (error) {
				if (signal.aborted) {
					if (isCurrentMissionRun(userId, runVersion)) {
						await panels.updateMissionPanel({
							missionStatus: 'inactive',
							currentMission: 'Sistema desativado pelo usuario.',
							progress: 0,
						});
					}
					return;
				}

				if (!isCurrentMissionRun(userId, runVersion)) return;

				await panels.updateMissionPanel({
					missionStatus: 'error',
					currentMission:
						error instanceof Error ? error.message : String(error),
					progress: 0,
				});
			} finally {
				await restoreMissionRichPresence(userId, token, runVersion);
			}
		},
	});
}

async function queueClearRun(userId: string) {
	const token = await getValidUserToken(userId);
	const panels = createPanels(userId);
	const record = await panelStore.getUser(userId);

	if (!token) {
		await panels.updateClearPanel({
			tokenConfigured: false,
			clearStatus: 'waiting',
		});
		throw new Error('Token is not configured.');
	}

	if (record.clearMode === 'userDm' && !record.clearTargetUserId) {
		await panels.updateClearPanel({
			tokenConfigured: true,
			clearStatus: 'error',
			currentMission: 'Configure o User ID antes de iniciar DM por ID.',
		});
		throw new Error('Target user ID is not configured.');
	}

	const isTargetedCleanup = record.clearMode === 'userDm';
	const targetUserId = isTargetedCleanup
		? record.clearTargetUserId
		: undefined;

	await panels.updateClearPanel({
		tokenConfigured: true,
		clearStatus: 'active',
		currentMission: isTargetedCleanup
			? `Preparando limpeza da DM ${targetUserId}.`
			: 'Preparando limpeza em massa.',
	});

	missionQueue.enqueue({
		userId,
		onQueued: async (position) => {
			await panels.updateClearPanel({
				clearStatus: 'waiting',
				currentMission:
					position > 1
						? `Limpeza aguardando na fila. Posicao ${position}.`
						: isTargetedCleanup
							? `Limpando DM ${targetUserId} e removendo contato...`
							: 'Limpeza em massa em andamento, aguarde...',
			});
		},
		onRejected: async (reason) => {
			await panels.updateClearPanel({
				clearStatus: 'error',
				currentMission: reason,
			});
		},
		onCancelled: async (reason) => {
			await panels.updateClearPanel({
				clearStatus: 'deactivated',
				currentMission: reason,
			});
		},
		run: async (signal) => {
			try {
				signal.throwIfAborted();
				await runDiscordDmCleanup({
					...createDiscordCleanupOptions(token),
					targetUserId,
					signal,
				});
				signal.throwIfAborted();
				await panels.updateClearPanel({
					clearStatus: 'completed',
					currentMission: isTargetedCleanup
						? `DM ${targetUserId} limpa e contato removido.`
						: 'Limpeza em massa concluida.',
				});
			} catch (error) {
				if (signal.aborted) {
					await panels.updateClearPanel({
						clearStatus: 'deactivated',
						currentMission: 'Sistema desativado pelo usuario.',
					});
					return;
				}

				await panels.updateClearPanel({
					clearStatus: 'error',
					currentMission:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	});
}

async function handleStartMission(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tokenStore.has(userId))) {
		await openTokenModal(interaction, MISSION_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	await queueMissionRun(userId);
}

async function handleMissionConcurrencySelect(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const selected = Number.parseInt(getSelectedValue(interaction) ?? '', 10);
	if (!Number.isFinite(selected)) {
		await safeReplyEphemeral(interaction, 'Valor de simultaneidade invalido.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	const concurrency = Math.max(1, Math.min(25, selected));
	await createPanels(userId).updateMissionPanel({
		missionConcurrency: concurrency,
		currentMission: `Configurado para ate ${concurrency} missoes simultaneas.`,
	});
}

async function handleStartClear(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tokenStore.has(userId))) {
		await openTokenModal(interaction, CLEAR_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	await queueClearRun(userId);
}

async function handleDeactivateMission(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	const reason = 'Sistema desativado pelo usuario.';
	invalidateMissionRun(userId);
	missionQueue.cancelUser(userId, reason);
	await createPanels(userId).updateMissionPanel({
		missionStatus: 'inactive',
		currentMission: reason,
		progress: 0,
	});
}

async function handleDeactivateClear(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;
	const reason = 'Sistema desativado pelo usuario.';
	missionQueue.cancelUser(userId, reason);
	await createPanels(userId).updateClearPanel({
		clearStatus: 'deactivated',
		currentMission: reason,
	});
}

async function handleTokenModal(interaction: APIModalSubmitInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const submittedToken = getModalValue(interaction, TOKEN_INPUT_CUSTOM_ID);
	if (!submittedToken?.trim()) {
		await safeReplyEphemeral(interaction, 'No token was submitted.');
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;

	const trimmedToken = submittedToken.trim();
	const validation = await validateDiscordToken(trimmedToken);
	if (!validation.valid) {
		await markTokenInvalid(userId);
		await editEphemeralReply(
			interaction,
			'Token invalido. Verifique o token e tente novamente.',
		);
		return;
	}

	await tokenStore.set(userId, trimmedToken);
	stopUserRuntimeSessions(userId);

	const panels = createPanels(userId);
	const hasPanelState = await panelStore.hasUser(userId);
	if (interaction.data.custom_id === CLEAR_TOKEN_MODAL_CUSTOM_ID) {
		if (hasPanelState) {
			await panels.updateClearPanel({
				tokenConfigured: true,
			});
		}
		await editEphemeralReply(
			interaction,
			'Token configured. Clear panel updated.',
		);
		return;
	}

	if (interaction.data.custom_id === MISSION_TOKEN_MODAL_CUSTOM_ID) {
		if (hasPanelState) {
			await panels.updateMissionPanel({
				tokenConfigured: true,
			});
		}
		await editEphemeralReply(
			interaction,
			'Token configured. Mission panel updated.',
		);
		return;
	}

	if (interaction.data.custom_id === VOICE_TOKEN_MODAL_CUSTOM_ID) {
		if (hasPanelState) {
			await refreshVoicePanel(userId, {
				tokenConfigured: true,
			});
		}
		await editEphemeralReply(
			interaction,
			'Token configured. Voice panel updated.',
		);
		return;
	}

	if (interaction.data.custom_id === RICH_PRESENCE_TOKEN_MODAL_CUSTOM_ID) {
		if (hasPanelState) {
			await panels.updateRichPresencePanel({
				tokenConfigured: true,
			});
		}
		await editEphemeralReply(
			interaction,
			'Token configured. Rich Presence panel updated.',
		);
		return;
	}
}

async function handleRichPresenceConfigModal(
	interaction: APIModalSubmitInteraction,
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	const config = parseRichPresenceConfig(interaction, record.richPresenceConfig);
	if (!config.name) {
		await safeReplyEphemeral(interaction, 'Activity name is required.');
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;
	await createPanels(userId).updateRichPresencePanel({
		richPresenceConfig: config,
		richPresenceUpdatedAt: new Date().toISOString(),
	});

	const token = await getValidUserToken(userId);
	if (token && record.richPresenceStatus === 'active') {
		getRichPresenceSession(userId, token).update(config);
	}

	await editEphemeralReply(
		interaction,
		'Rich Presence configuration updated.',
	);
}

async function handleRichPresenceAdvancedModal(
	interaction: APIModalSubmitInteraction,
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	const config = parseRichPresenceAdvancedConfig(
		interaction,
		record.richPresenceConfig,
	);

	if (!(await tryDeferEphemeralReply(interaction))) return;
	await createPanels(userId).updateRichPresencePanel({
		richPresenceConfig: config,
		richPresenceUpdatedAt: new Date().toISOString(),
	});

	const token = await getValidUserToken(userId);
	if (token && record.richPresenceStatus === 'active') {
		const validationError = validateRichPresenceConfig(config);
		if (!validationError) getRichPresenceSession(userId, token).update(config);
	}

	await editEphemeralReply(interaction, 'Configuracao avancada atualizada.');
}

async function handleRichPresenceButtonModal(
	interaction: APIModalSubmitInteraction,
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	const config = parseRichPresenceButtonConfig(
		interaction,
		record.richPresenceConfig,
	);
	if (Boolean(config.buttonLabel) !== Boolean(config.buttonUrl)) {
		await safeReplyEphemeral(
			interaction,
			'Preencha o texto e a URL do botao, ou deixe os dois vazios.',
		);
		return;
	}
	if (config.activityType === 1 && !isSupportedStreamingUrl(config.buttonUrl)) {
		await safeReplyEphemeral(
			interaction,
			'Para usar Transmitindo, a URL precisa ser da Twitch ou YouTube. Para Spotify ou site normal, use o tipo Jogando.',
		);
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;
	await createPanels(userId).updateRichPresencePanel({
		richPresenceConfig: config,
		richPresenceUpdatedAt: new Date().toISOString(),
	});

	const token = await getValidUserToken(userId);
	if (token && record.richPresenceStatus === 'active') {
		getRichPresenceSession(userId, token).update(config);
	}

	await editEphemeralReply(interaction, 'Botao do Rich Presence atualizado.');
}

async function handleRichPresenceImagesModal(
	interaction: APIModalSubmitInteraction,
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const record = await panelStore.getUser(userId);
	const textConfig = parseRichPresenceImagesConfig(
		interaction,
		record.richPresenceConfig,
	);

	if (!(await tryDeferEphemeralReply(interaction))) return;
	let uploadedImages: UploadedRichPresenceImages;
	try {
		uploadedImages = await uploadRichPresenceImagesToDm(userId, interaction);
	} catch (error) {
		await editEphemeralReply(
			interaction,
			error instanceof Error
				? error.message
				: 'Falha ao processar upload da imagem.',
		);
		return;
	}

	const config: RichPresenceRuntimeConfig = {
		...textConfig,
		...(uploadedImages.largeImage
			? { largeImage: uploadedImages.largeImage }
			: {}),
		...(uploadedImages.smallImage
			? { smallImage: uploadedImages.smallImage }
			: {}),
	};

	await createPanels(userId).updateRichPresencePanel({
		richPresenceConfig: config,
		richPresenceUpdatedAt: new Date().toISOString(),
	});

	const token = await getValidUserToken(userId);
	if (token && record.richPresenceStatus === 'active') {
		getRichPresenceSession(userId, token).update(config);
	}

	await editEphemeralReply(interaction, 'Imagens do Rich Presence atualizadas.');
}

async function handleRichPresenceImageUploadModal(
	interaction: APIModalSubmitInteraction,
	imageKind: 'large' | 'small',
) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const uploadCustomId =
		imageKind === 'large'
			? RICH_LARGE_IMAGE_UPLOAD_CUSTOM_ID
			: RICH_SMALL_IMAGE_UPLOAD_CUSTOM_ID;
	const attachment = getUploadedModalImage(interaction, uploadCustomId);
	if (!attachment) {
		await safeReplyEphemeral(interaction, 'Envie uma imagem valida.');
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;

	let uploadedUrl: string;
	try {
		uploadedUrl = await uploadRichPresenceImageToDm(
			userId,
			attachment,
			imageKind === 'large'
				? 'rich-presence-large-image.png'
				: 'rich-presence-small-image.png',
		);
	} catch (error) {
		await editEphemeralReply(
			interaction,
			error instanceof Error
				? error.message
				: 'Falha ao processar upload da imagem.',
		);
		return;
	}

	const record = await panelStore.getUser(userId);
	const config: RichPresenceRuntimeConfig = {
		...record.richPresenceConfig,
		...(imageKind === 'large'
			? { largeImage: uploadedUrl }
			: { smallImage: uploadedUrl }),
	};
	await createPanels(userId).updateRichPresencePanel({
		richPresenceConfig: config,
		richPresenceUpdatedAt: new Date().toISOString(),
	});

	const token = await getValidUserToken(userId);
	if (token && record.richPresenceStatus === 'active') {
		const validationError = validateRichPresenceConfig(config);
		if (!validationError) getRichPresenceSession(userId, token).update(config);
	}

	await editEphemeralReply(
		interaction,
		imageKind === 'large'
			? 'Imagem grande atualizada.'
			: 'Imagem pequena atualizada.',
	);
}

async function handleRichPresenceActivityTypeSelect(interaction: APIInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const activityType = parseRichPresenceActivityType(getSelectedValue(interaction));
	if (activityType === null) {
		await safeReplyEphemeral(interaction, 'Tipo de atividade invalido.');
		return;
	}

	const record = await panelStore.getUser(userId);
	if (activityType === 1 && !isSupportedStreamingUrl(record.richPresenceConfig.buttonUrl)) {
		await safeReplyEphemeral(
			interaction,
			'Transmitindo precisa de uma URL da Twitch ou YouTube. Configure essa URL no botao primeiro, ou use Jogando.',
		);
		return;
	}

	if (!(await tryDeferComponent(interaction))) return;

	const config: RichPresenceRuntimeConfig = {
		...record.richPresenceConfig,
		activityType,
	};
	await createPanels(userId).updateRichPresencePanel({
		richPresenceConfig: config,
		richPresenceUpdatedAt: new Date().toISOString(),
	});

	const token = await getValidUserToken(userId);
	if (token && record.richPresenceStatus === 'active') {
		getRichPresenceSession(userId, token).update(config);
	}
}

async function handleVoiceConfigModal(interaction: APIModalSubmitInteraction) {
	const userId = getInteractionUserId(interaction);
	if (!userId) {
		await safeReplyEphemeral(interaction, 'Could not identify the user.');
		return;
	}

	const guildId = getModalValue(
		interaction,
		VOICE_GUILD_ID_INPUT_CUSTOM_ID,
	)?.trim();
	const channelId = getModalValue(
		interaction,
		VOICE_CHANNEL_ID_INPUT_CUSTOM_ID,
	)?.trim();

	if (!guildId || !channelId) {
		await safeReplyEphemeral(
			interaction,
			'ID do servidor e ID do canal de voz sao obrigatorios.',
		);
		return;
	}

	if (!(await tryDeferEphemeralReply(interaction))) return;

	const token = await requireValidTokenAfterAck(interaction, userId);
	if (!token) return;

	await applyVoiceManualConfig(userId, token, guildId, channelId);
	getVoiceSession(userId, token).start(guildId, channelId);
	await refreshVoicePanel(userId, {
		tokenConfigured: true,
		voiceStatus: 'reconnecting',
	});
	await editEphemeralReply(
		interaction,
		'Voice Session configurada e conexao iniciada.',
	);
}

async function handleInteraction(interaction: APIInteraction) {
	if (
		interaction.type === InteractionType.ApplicationCommand &&
		interaction.data.name === PANEL_COMMAND_NAME
	) {
		await handleMainPanelCommand(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === MAIN_PANEL_SELECT_CUSTOM_ID
	) {
		try {
			const selectedValue = getSelectedValue(interaction);
			if (selectedValue === MAIN_PANEL_CLEAR_VALUE) {
				await sendDmPanel(interaction, 'clear');
				return;
			}

			if (selectedValue === MAIN_PANEL_MISSION_VALUE) {
				await sendDmPanel(interaction, 'mission');
				return;
			}

			if (selectedValue === MAIN_PANEL_VOICE_VALUE) {
				await sendDmPanel(interaction, 'voice');
				return;
			}

			if (selectedValue === MAIN_PANEL_RICH_PRESENCE_VALUE) {
				await sendDmPanel(interaction, 'richPresence');
				return;
			}

			if (selectedValue === MAIN_PANEL_USERNAME_CHECKER_VALUE) {
				await sendDmPanel(interaction, 'usernameChecker');
				return;
			}

			if (selectedValue === MAIN_PANEL_DELETE_DM_VALUE) {
				await deleteBotDmPanels(interaction);
				return;
			}
		} finally {
			await resetMainPanelSelection(interaction);
		}
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === START_CLEAR_CUSTOM_ID
	) {
		await handleStartClear(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === SET_CLEAR_BULK_MODE_CUSTOM_ID
	) {
		await handleSetClearBulkMode(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === SET_CLEAR_USER_DM_MODE_CUSTOM_ID
	) {
		await openClearTargetUserModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_CLEAR_TARGET_USER_CUSTOM_ID
	) {
		await openClearTargetUserModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === START_MISSION_CUSTOM_ID
	) {
		await handleStartMission(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === MISSION_CONCURRENCY_SELECT_CUSTOM_ID
	) {
		await handleMissionConcurrencySelect(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === DEACTIVATE_CLEAR_CUSTOM_ID
	) {
		await handleDeactivateClear(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === DEACTIVATE_MISSION_CUSTOM_ID
	) {
		await handleDeactivateMission(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_CLEAR_TOKEN_CUSTOM_ID
	) {
		await openTokenModalIfNeeded(interaction, CLEAR_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_MISSION_TOKEN_CUSTOM_ID
	) {
		await openTokenModalIfNeeded(interaction, MISSION_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === VOICE_GUILD_SELECT_CUSTOM_ID
	) {
		await handleVoiceGuildSelect(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === VOICE_CHANNEL_SELECT_CUSTOM_ID
	) {
		await handleVoiceChannelSelect(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_VOICE_TOKEN_CUSTOM_ID
	) {
		await openTokenModalIfNeeded(interaction, VOICE_TOKEN_MODAL_CUSTOM_ID);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === START_VOICE_CUSTOM_ID
	) {
		await handleStartVoice(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CHANGE_VOICE_CHANNEL_CUSTOM_ID
	) {
		await handleChangeVoiceChannel(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === STOP_VOICE_CUSTOM_ID
	) {
		await handleStopVoice(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_RICH_PRESENCE_TOKEN_CUSTOM_ID
	) {
		await openTokenModalIfNeeded(
			interaction,
			RICH_PRESENCE_TOKEN_MODAL_CUSTOM_ID,
		);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === RICH_PRESENCE_ACTIVITY_TYPE_SELECT_CUSTOM_ID
	) {
		await handleRichPresenceActivityTypeSelect(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === APPLY_RICH_PRESENCE_CUSTOM_ID
	) {
		await handleApplyRichPresence(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_RICH_PRESENCE_CUSTOM_ID
	) {
		await openRichPresenceConfigModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_RICH_PRESENCE_ADVANCED_CUSTOM_ID
	) {
		await openRichPresenceAdvancedModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_RICH_PRESENCE_BUTTON_CUSTOM_ID
	) {
		await openRichPresenceButtonModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_RICH_PRESENCE_LARGE_IMAGE_CUSTOM_ID
	) {
		await openRichPresenceLargeImageModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_RICH_PRESENCE_SMALL_IMAGE_CUSTOM_ID
	) {
		await openRichPresenceSmallImageModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_RICH_PRESENCE_IMAGES_CUSTOM_ID
	) {
		await openRichPresenceImagesModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === RESET_RICH_PRESENCE_CUSTOM_ID
	) {
		await handleResetRichPresence(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === START_RICH_PRESENCE_CUSTOM_ID
	) {
		await handleStartRichPresence(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === STOP_RICH_PRESENCE_CUSTOM_ID
	) {
		await handleStopRichPresence(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === START_USERNAME_CHECKER_CUSTOM_ID
	) {
		await handleStartUsernameChecker(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === STOP_USERNAME_CHECKER_CUSTOM_ID
	) {
		await handleStopUsernameChecker(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.MessageComponent &&
		interaction.data.custom_id === CONFIGURE_USERNAME_CHECKER_CUSTOM_ID
	) {
		await openUsernameCheckerConfigModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		(interaction.data.custom_id === CLEAR_TOKEN_MODAL_CUSTOM_ID ||
			interaction.data.custom_id === MISSION_TOKEN_MODAL_CUSTOM_ID ||
			interaction.data.custom_id === VOICE_TOKEN_MODAL_CUSTOM_ID ||
			interaction.data.custom_id === RICH_PRESENCE_TOKEN_MODAL_CUSTOM_ID)
	) {
		await handleTokenModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === CLEAR_TARGET_USER_MODAL_CUSTOM_ID
	) {
		await handleClearTargetUserModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === RICH_PRESENCE_CONFIG_MODAL_CUSTOM_ID
	) {
		await handleRichPresenceConfigModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === RICH_PRESENCE_ADVANCED_MODAL_CUSTOM_ID
	) {
		await handleRichPresenceAdvancedModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === RICH_PRESENCE_BUTTON_MODAL_CUSTOM_ID
	) {
		await handleRichPresenceButtonModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === RICH_PRESENCE_LARGE_IMAGE_MODAL_CUSTOM_ID
	) {
		await handleRichPresenceImageUploadModal(interaction, 'large');
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === RICH_PRESENCE_SMALL_IMAGE_MODAL_CUSTOM_ID
	) {
		await handleRichPresenceImageUploadModal(interaction, 'small');
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === RICH_PRESENCE_IMAGES_MODAL_CUSTOM_ID
	) {
		await handleRichPresenceImagesModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === USERNAME_CHECKER_CONFIG_MODAL_CUSTOM_ID
	) {
		await handleUsernameCheckerConfigModal(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.data.custom_id === VOICE_CONFIG_MODAL_CUSTOM_ID
	) {
		await handleVoiceConfigModal(interaction);
	}
}

client.once(
	GatewayDispatchEvents.Ready,
	async ({ data }: { data: GatewayReadyDispatchData }) => {
		console.log(`Logged in as ${data.user.username}.`);
		await registerCommands(data);
	},
);

client.on(
	GatewayDispatchEvents.InteractionCreate,
	async ({ data }: { data: APIInteraction }) => {
		try {
			await handleInteraction(data);
		} catch (error) {
			if (isExpiredOrAcknowledgedInteraction(error)) return;

			console.error('Interaction handling failed:', error);
			await safeReplyEphemeral(
				data,
				error instanceof Error ? error.message : 'Unknown error.',
			);
		}
	},
);

gateway.connect();
