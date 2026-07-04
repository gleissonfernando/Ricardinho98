// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import type { Client } from '@discordjs/core';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} from 'discord.js';
import { MissionStatusUpdate } from './missionRunner';
import {
	ClearCleanupMode,
	PanelStore,
	PanelSystemStatus,
	RichPresenceActivityType,
	RichPresenceConfig,
	RichPresenceStatus,
	UserPanelRecord,
	VoiceSessionStatus,
} from './panelStore';

type ContainerBuilderShape = {
	setAccentColor(color: number): ContainerBuilderShape;
	addTextDisplayComponents(...components: unknown[]): ContainerBuilderShape;
	addSeparatorComponents(...components: unknown[]): ContainerBuilderShape;
	addActionRowComponents(...components: unknown[]): ContainerBuilderShape;
	toJSON(): unknown;
};

type TextDisplayBuilderShape = {
	setContent(content: string): TextDisplayBuilderShape;
	toJSON(): unknown;
};

type SeparatorBuilderShape = {
	setDivider(divider: boolean): SeparatorBuilderShape;
	toJSON(): unknown;
};

type BotDmMessage = {
	id: string;
	author?: {
		id?: string;
	};
	components?: unknown[];
};

export type PanelSelectOption = {
	label: string;
	value: string;
	description?: string;
};

const {
	ContainerBuilder,
	TextDisplayBuilder,
	SeparatorBuilder,
} = require('discord.js') as {
	ContainerBuilder: new () => ContainerBuilderShape;
	TextDisplayBuilder: new () => TextDisplayBuilderShape;
	SeparatorBuilder: new () => SeparatorBuilderShape;
};

const PANEL_MESSAGE_FETCH_LIMIT = 100;

export const MAIN_PANEL_SELECT_CUSTOM_ID = 'main-panel:function';
export const MAIN_PANEL_CLEAR_VALUE = 'clear';
export const MAIN_PANEL_DELETE_DM_VALUE = 'delete-bot-dm';
export const MAIN_PANEL_MISSION_VALUE = 'mission';
export const MAIN_PANEL_RICH_PRESENCE_VALUE = 'rich-presence';
export const MAIN_PANEL_VOICE_VALUE = 'voice';
export const MAIN_PANEL_USERNAME_CHECKER_VALUE = 'username-checker';

export const START_CLEAR_CUSTOM_ID = 'clear:start';
export const DEACTIVATE_CLEAR_CUSTOM_ID = 'clear:deactivate';
export const CONFIGURE_CLEAR_TOKEN_CUSTOM_ID = 'clear:configure-token';
export const SET_CLEAR_BULK_MODE_CUSTOM_ID = 'clear:mode-bulk';
export const SET_CLEAR_USER_DM_MODE_CUSTOM_ID = 'clear:mode-user-dm';
export const CONFIGURE_CLEAR_TARGET_USER_CUSTOM_ID =
	'clear:configure-target-user';

export const START_MISSION_CUSTOM_ID = 'mission:start';
export const DEACTIVATE_MISSION_CUSTOM_ID = 'mission:deactivate';
export const CONFIGURE_MISSION_TOKEN_CUSTOM_ID = 'mission:configure-token';
export const MISSION_CONCURRENCY_SELECT_CUSTOM_ID =
	'mission:select-concurrency';

export const VOICE_GUILD_SELECT_CUSTOM_ID = 'voice:select-guild';
export const VOICE_CHANNEL_SELECT_CUSTOM_ID = 'voice:select-channel';
export const START_VOICE_CUSTOM_ID = 'voice:start';
export const CHANGE_VOICE_CHANNEL_CUSTOM_ID = 'voice:change-channel';
export const STOP_VOICE_CUSTOM_ID = 'voice:stop';
export const CONFIGURE_VOICE_TOKEN_CUSTOM_ID = 'voice:configure-token';

export const CONFIGURE_RICH_PRESENCE_CUSTOM_ID = 'rich-presence:configure';
export const CONFIGURE_RICH_PRESENCE_BUTTON_CUSTOM_ID =
	'rich-presence:configure-button';
export const CONFIGURE_RICH_PRESENCE_IMAGES_CUSTOM_ID =
	'rich-presence:configure-images';
export const CONFIGURE_RICH_PRESENCE_ADVANCED_CUSTOM_ID =
	'rich-presence:configure-advanced';
export const CONFIGURE_RICH_PRESENCE_LARGE_IMAGE_CUSTOM_ID =
	'rich-presence:configure-large-image';
export const CONFIGURE_RICH_PRESENCE_SMALL_IMAGE_CUSTOM_ID =
	'rich-presence:configure-small-image';
export const APPLY_RICH_PRESENCE_CUSTOM_ID = 'rich-presence:apply';
export const RESET_RICH_PRESENCE_CUSTOM_ID = 'rich-presence:reset';
export const RICH_PRESENCE_ACTIVITY_TYPE_SELECT_CUSTOM_ID =
	'rich-presence:select-activity-type';
export const START_RICH_PRESENCE_CUSTOM_ID = 'rich-presence:start';
export const STOP_RICH_PRESENCE_CUSTOM_ID = 'rich-presence:stop';
export const CONFIGURE_RICH_PRESENCE_TOKEN_CUSTOM_ID =
	'rich-presence:configure-token';

export const START_USERNAME_CHECKER_CUSTOM_ID = 'username-checker:start';
export const STOP_USERNAME_CHECKER_CUSTOM_ID = 'username-checker:stop';
export const CONFIGURE_USERNAME_CHECKER_CUSTOM_ID =
	'username-checker:configure';

type PanelPayloadOptions = {
	record: UserPanelRecord;
	tokenConfigured: boolean;
};

type VoicePanelPayloadOptions = PanelPayloadOptions & {
	guildOptions?: PanelSelectOption[];
	channelOptions?: PanelSelectOption[];
};

type UserPanelType =
	| 'clear'
	| 'mission'
	| 'voice'
	| 'richPresence'
	| 'usernameChecker';

const PANEL_ACCENT = 0x4b5563;

function statusLabel(status: PanelSystemStatus): string {
	switch (status) {
		case 'active':
			return 'Active';
		case 'inactive':
			return 'Inactive';
		case 'deactivated':
			return 'Deactivated';
		case 'waiting':
			return 'Waiting';
		case 'running':
			return 'Running';
		case 'completed':
			return 'Completed';
		case 'error':
			return 'Error';
	}
}

function voiceStatusLabel(status: VoiceSessionStatus): string {
	switch (status) {
		case 'connected':
			return 'Conectado';
		case 'disconnected':
			return 'Desconectado';
		case 'reconnecting':
			return 'Reconectando';
	}
}

function richPresenceStatusLabel(status: RichPresenceStatus): string {
	switch (status) {
		case 'active':
			return 'Ativo';
		case 'inactive':
			return 'Inativo';
	}
}

function richPresenceActivityTypeLabel(type: RichPresenceActivityType = 0): string {
	switch (type) {
		case 0:
			return 'Jogando';
		case 1:
			return 'Transmitindo';
		case 2:
			return 'Ouvindo';
		case 3:
			return 'Assistindo';
		case 5:
			return 'Competindo';
	}
}

function richPresenceActivityTypeOptions(): PanelSelectOption[] {
	return [
		{
			label: 'Jogando',
			value: '0',
			description: 'Mostra a atividade como Jogando.',
		},
		{
			label: 'Transmitindo',
			value: '1',
			description: 'Mostra a atividade como Transmitindo.',
		},
		{
			label: 'Ouvindo',
			value: '2',
			description: 'Mostra a atividade como Ouvindo.',
		},
		{
			label: 'Assistindo',
			value: '3',
			description: 'Mostra a atividade como Assistindo.',
		},
		{
			label: 'Competindo',
			value: '5',
			description: 'Mostra a atividade como Competindo.',
		},
	];
}

function formatUpdatedAt(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'Unavailable';

	return new Intl.DateTimeFormat('pt-BR', {
		dateStyle: 'short',
		timeStyle: 'medium',
	}).format(date);
}

function progressLabel(progress: number): string {
	const normalized = Math.max(0, Math.min(100, Math.round(progress)));
	return `${normalized}%`;
}

function durationLabel(value?: string): string {
	if (!value) return 'Sem conexao ativa';

	const startedAt = new Date(value).getTime();
	if (Number.isNaN(startedAt)) return 'Indisponivel';

	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const hours = Math.floor(elapsedSeconds / 3600);
	const minutes = Math.floor((elapsedSeconds % 3600) / 60);
	const seconds = elapsedSeconds % 60;

	return hours > 0
		? `${hours}h ${minutes}m ${seconds}s`
		: `${minutes}m ${seconds}s`;
}

function tokenLabel(tokenConfigured: boolean): string {
	return tokenConfigured ? 'Configurado' : 'Nao configurado';
}

function clearModeLabel(mode: ClearCleanupMode): string {
	return mode === 'userDm' ? 'DM por ID' : 'Em massa';
}

function missionConcurrencyOptions(): PanelSelectOption[] {
	return [1, 2, 3, 4, 5, 10, 15, 20, 25].map((value) => ({
		label: value === 25 ? 'Todas' : `${value}`,
		value: String(value),
		description:
			value === 25
				? 'Executa ate 25 missoes simultaneas.'
				: `Executa ate ${value} missoes ao mesmo tempo.`,
	}));
}

function richPresencePanelStatusLabel(status: RichPresenceStatus): string {
	return status === 'active' ? 'Ativado' : 'Desativado';
}

function limitedText(value: string, maxLength: number): string {
	return value.length > maxLength
		? `${value.slice(0, Math.max(0, maxLength - 3))}...`
		: value;
}

function codeValue(value?: string): string {
	return `\`${value || 'nao definido'}\``;
}

function richPresenceStartLabel(value?: string): string {
	if (!value) return 'agora';

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;

	return new Intl.DateTimeFormat('pt-BR', {
		dateStyle: 'short',
		timeStyle: 'medium',
	}).format(date);
}

function selectOption(option: PanelSelectOption): StringSelectMenuOptionBuilder {
	const builder = new StringSelectMenuOptionBuilder()
		.setLabel(limitedText(option.label, 100))
		.setValue(option.value);

	if (option.description) {
		builder.setDescription(limitedText(option.description, 100));
	}

	return builder;
}

function selectMenu(
	customId: string,
	placeholder: string,
	options: PanelSelectOption[],
): StringSelectMenuBuilder {
	return new StringSelectMenuBuilder()
		.setCustomId(customId)
		.setPlaceholder(limitedText(placeholder, 150))
		.addOptions(options.slice(0, 25).map(selectOption));
}

function text(content: string): TextDisplayBuilderShape {
	return new TextDisplayBuilder().setContent(content);
}

function separator(): SeparatorBuilderShape {
	return new SeparatorBuilder().setDivider(true);
}

function componentsV2Payload(container: ContainerBuilderShape): Record<string, unknown> {
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [container.toJSON()],
	};
}

function button(
	customId: string,
	label: string,
	style: ButtonStyle,
	disabled = false,
): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(customId)
		.setLabel(label)
		.setStyle(style)
		.setDisabled(disabled);
}

export function mapMissionStatusToPanel(
	update: MissionStatusUpdate,
	current: UserPanelRecord,
): Partial<UserPanelRecord> {
	const missionStatus: PanelSystemStatus =
		update.state === 'Waiting'
			? 'waiting'
			: update.state === 'Running'
				? 'running'
				: update.state === 'Completed'
					? 'completed'
					: 'error';

	return {
		missionStatus,
		currentMission: update.currentMission ?? current.currentMission,
		completedCount:
			update.state === 'Completed' && update.currentIndex
				? update.currentIndex
				: current.completedCount,
		totalMissions: update.totalMissions ?? current.totalMissions,
		progress: update.progress ?? current.progress,
	};
}

export function buildMainPanelPayload(): Record<string, unknown> {
	const selectMenu = new StringSelectMenuBuilder()
		.setCustomId(MAIN_PANEL_SELECT_CUSTOM_ID)
		.setPlaceholder('Selecione um modulo')
		.addOptions(
			new StringSelectMenuOptionBuilder()
				.setLabel('Mission System')
				.setDescription('Manage mission automations and progress')
				.setValue(MAIN_PANEL_MISSION_VALUE),
			new StringSelectMenuOptionBuilder()
				.setLabel('Clean System')
				.setDescription('Manage system cleanup operations')
				.setValue(MAIN_PANEL_CLEAR_VALUE),
			new StringSelectMenuOptionBuilder()
				.setLabel('Voice Session')
				.setDescription('Manage a persistent voice channel session')
				.setValue(MAIN_PANEL_VOICE_VALUE),
			new StringSelectMenuOptionBuilder()
				.setLabel('Rich Presence')
				.setDescription('Manage profile activity display')
				.setValue(MAIN_PANEL_RICH_PRESENCE_VALUE),
			new StringSelectMenuOptionBuilder()
				.setLabel('Username Checker')
				.setDescription('Manage username availability checks')
				.setValue(MAIN_PANEL_USERNAME_CHECKER_VALUE),
			new StringSelectMenuOptionBuilder()
				.setLabel('Delete Bot DM')
				.setDescription('Remove panel messages sent by the bot in DM')
				.setValue(MAIN_PANEL_DELETE_DM_VALUE),
		);
	const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		selectMenu,
	);
	const container = new ContainerBuilder()
		.setAccentColor(PANEL_ACCENT)
		.addTextDisplayComponents(
			text(
				'# Control Center\n' +
					'Selecione um modulo para abrir a interface dedicada por mensagem direta.',
			),
		)
		.addSeparatorComponents(separator())
		.addActionRowComponents(row);

	return componentsV2Payload(container);
}

export function buildClearPanelPayload({
	record,
	tokenConfigured,
}: PanelPayloadOptions): Record<string, unknown> {
	const modeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(
			SET_CLEAR_BULK_MODE_CUSTOM_ID,
			'Em massa',
			record.clearMode === 'bulk' ? ButtonStyle.Primary : ButtonStyle.Secondary,
		),
		button(
			SET_CLEAR_USER_DM_MODE_CUSTOM_ID,
			'DM por ID',
			record.clearMode === 'userDm'
				? ButtonStyle.Primary
				: ButtonStyle.Secondary,
		),
		button(
			CONFIGURE_CLEAR_TARGET_USER_CUSTOM_ID,
			'Definir ID',
			ButtonStyle.Secondary,
		),
	);
	const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(START_CLEAR_CUSTOM_ID, 'Start', ButtonStyle.Secondary),
		button(
			CONFIGURE_CLEAR_TOKEN_CUSTOM_ID,
			'Configure Token',
			ButtonStyle.Secondary,
			tokenConfigured,
		),
		button(DEACTIVATE_CLEAR_CUSTOM_ID, 'Deactivate', ButtonStyle.Secondary),
	);
	const currentExecution = record.currentMission || 'No execution in progress';
	const targetUser = record.clearTargetUserId || 'Nao definido';
	const container = new ContainerBuilder()
		.setAccentColor(PANEL_ACCENT)
		.addTextDisplayComponents(
			text('# Clean System\nCleanup operations and account maintenance.'),
		)
		.addSeparatorComponents(separator())
		.addTextDisplayComponents(
			text(
				`**System Status:** ${statusLabel(record.clearStatus)}\n` +
					`**Configured Token:** ${tokenLabel(tokenConfigured)}\n` +
					`**Modo de limpeza:** ${clearModeLabel(record.clearMode)}\n` +
					`**User ID alvo:** ${targetUser}\n` +
					`**Current Execution:** ${currentExecution}\n` +
					`**Last Synchronization:** ${formatUpdatedAt(record.updatedAt)}`,
			),
		)
		.addSeparatorComponents(separator())
		.addActionRowComponents(modeRow)
		.addActionRowComponents(actionRow);

	return componentsV2Payload(container);
}

export function buildMissionPanelPayload({
	record,
	tokenConfigured,
}: PanelPayloadOptions): Record<string, unknown> {
	const missionName = record.currentMission || 'No mission in progress';
	const concurrencyRow = new ActionRowBuilder<StringSelectMenuBuilder>()
		.addComponents(
			selectMenu(
				MISSION_CONCURRENCY_SELECT_CUSTOM_ID,
				`Missoes simultaneas: ${record.missionConcurrency}`,
				missionConcurrencyOptions(),
			),
		);
	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(START_MISSION_CUSTOM_ID, 'Start', ButtonStyle.Secondary),
		button(
			CONFIGURE_MISSION_TOKEN_CUSTOM_ID,
			'Configure Token',
			ButtonStyle.Secondary,
			tokenConfigured,
		),
		button(DEACTIVATE_MISSION_CUSTOM_ID, 'Deactivate', ButtonStyle.Secondary),
	);
	const container = new ContainerBuilder()
		.setAccentColor(PANEL_ACCENT)
		.addTextDisplayComponents(
			text('# Mission System\nMission automation status and execution controls.'),
		)
		.addSeparatorComponents(separator())
		.addTextDisplayComponents(
			text(
				`**System:** Mission System\n` +
					`**Status:** ${statusLabel(record.missionStatus)}\n` +
					`**Configured Token:** ${tokenLabel(tokenConfigured)}\n` +
					`**Missoes simultaneas:** ${record.missionConcurrency}\n` +
					`**Current Mission:** ${missionName}\n` +
					`**Progress:** ${progressLabel(record.progress)}\n` +
					`**Last Synchronization:** ${formatUpdatedAt(record.updatedAt)}`,
			),
		)
		.addSeparatorComponents(separator())
		.addActionRowComponents(concurrencyRow)
		.addActionRowComponents(row);

	return componentsV2Payload(container);
}

export function buildUsernameCheckerPanelPayload({
	record,
}: Pick<PanelPayloadOptions, 'record'>): Record<string, unknown> {
	const stats = record.usernameCheckerStats;
	const options = record.usernameCheckerOptions;
	const isRunning = ['active', 'running', 'waiting'].includes(
		record.usernameCheckerStatus,
	);
	const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(
			START_USERNAME_CHECKER_CUSTOM_ID,
			'Start',
			ButtonStyle.Secondary,
			isRunning,
		),
		button(
			CONFIGURE_USERNAME_CHECKER_CUSTOM_ID,
			'Configure',
			ButtonStyle.Secondary,
			isRunning,
		),
		button(
			STOP_USERNAME_CHECKER_CUSTOM_ID,
			'Stop',
			ButtonStyle.Danger,
			!isRunning,
		),
	);
	const lastUpdate = record.usernameCheckerUpdatedAt
		? formatUpdatedAt(record.usernameCheckerUpdatedAt)
		: 'Never';
	const container = new ContainerBuilder()
		.setAccentColor(PANEL_ACCENT)
		.addTextDisplayComponents(
			text('# Username Checker\nUsername availability status and controls.'),
		)
		.addSeparatorComponents(separator())
		.addTextDisplayComponents(
			text(
					`**Status:** ${statusLabel(record.usernameCheckerStatus)}\n` +
					`**Length:** ${options.usernameLength ?? 4}\n` +
					`**Concurrency:** ${options.concurrency ?? 'Auto'}\n` +
					`**Delay:** ${options.requestDelay ?? 2000}ms\n` +
					`**Last Event:** ${record.usernameCheckerLastEvent ?? 'No recent event'}\n` +
					`**Last Update:** ${lastUpdate}`,
			),
		)
		.addSeparatorComponents(separator())
		.addTextDisplayComponents(
			text(
				`**Hits:** ${stats.hits}\n` +
					`**Taken:** ${stats.taken}\n` +
					`**Errors:** ${stats.errors}\n` +
					`**Active Proxies:** ${stats.activeProxies}\n` +
					`**Dead Proxies:** ${stats.deadProxies}\n` +
					`**Banned Proxies:** ${stats.bannedProxies}\n` +
					`**Workers Running:** ${stats.workersRunning}`,
			),
		)
		.addSeparatorComponents(separator())
		.addActionRowComponents(controls);

	return componentsV2Payload(container);
}

function richPresenceConfigLabel(config: RichPresenceConfig): string {
	const items = [
		`**Tipo:** ${codeValue(richPresenceActivityTypeLabel(config.activityType))}`,
		`**Nome:** ${codeValue(config.name)}`,
		`**Detalhes:** ${codeValue(config.details)}`,
		`**Estado:** ${codeValue(config.state)}`,
		`**ID de um bot criado na sua conta:** ${codeValue(config.applicationId)}`,
		`**Botao:** ${
			config.buttonLabel && config.buttonUrl
				? `${codeValue(config.buttonLabel)} -> ${config.buttonUrl}`
				: codeValue()
		}`,
		`**Imagem grande:** ${config.largeImage || codeValue()}`,
		`**Texto img grande:** ${codeValue(config.largeText)}`,
		`**Imagem pequena:** ${config.smallImage || codeValue()}`,
		`**Inicio (opcional):** ${codeValue(richPresenceStartLabel(config.startTimestamp))}`,
	];

	return items.join('\n');
}

export function buildVoicePanelPayload({
	record,
	tokenConfigured,
	guildOptions = [],
	channelOptions = [],
}: VoicePanelPayloadOptions): Record<string, unknown> {
	const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(
			CONFIGURE_VOICE_TOKEN_CUSTOM_ID,
			'Configurar Token',
			ButtonStyle.Secondary,
			tokenConfigured,
		),
		button(START_VOICE_CUSTOM_ID, 'Conectar', ButtonStyle.Secondary),
		button(CHANGE_VOICE_CHANNEL_CUSTOM_ID, 'Alterar Canal', ButtonStyle.Secondary),
		button(STOP_VOICE_CUSTOM_ID, 'Desconectar', ButtonStyle.Secondary),
	);
	const container = new ContainerBuilder()
		.setAccentColor(PANEL_ACCENT)
		.addTextDisplayComponents(
			text('# Voice Session\nGerenciamento de sessao persistente em canal de voz.'),
		)
		.addSeparatorComponents(separator())
		.addTextDisplayComponents(
			text(
				`**Servidor conectado:** ${record.voiceGuildName || 'Nao selecionado'}\n` +
					`**Canal atual:** ${record.voiceChannelName || 'Nao selecionado'}\n` +
					`**Tempo de conexao ativo:** ${durationLabel(record.voiceConnectedAt)}\n` +
					`**Status da sessao:** ${voiceStatusLabel(record.voiceStatus)}\n` +
					`**Token configurado:** ${tokenLabel(tokenConfigured)}`,
			),
		)
		.addSeparatorComponents(separator());

	if (guildOptions.length > 0) {
		container.addActionRowComponents(
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				selectMenu(
					VOICE_GUILD_SELECT_CUSTOM_ID,
					record.voiceGuildName || 'Selecionar servidor de destino',
					guildOptions,
				),
			),
		);
	}

	if (channelOptions.length > 0) {
		container.addActionRowComponents(
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				selectMenu(
					VOICE_CHANNEL_SELECT_CUSTOM_ID,
					record.voiceChannelName || 'Selecionar canal de voz',
					channelOptions,
				),
			),
		);
	}

	container.addActionRowComponents(controls);

	return componentsV2Payload(container);
}

export function buildRichPresencePanelPayload({
	record,
	tokenConfigured,
}: PanelPayloadOptions): Record<string, unknown> {
	const configControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(APPLY_RICH_PRESENCE_CUSTOM_ID, 'Aplicar Configs', ButtonStyle.Success),
		button(
			CONFIGURE_RICH_PRESENCE_CUSTOM_ID,
			'Editar textos',
			ButtonStyle.Primary,
		),
		button(
			CONFIGURE_RICH_PRESENCE_ADVANCED_CUSTOM_ID,
			'Avancado',
			ButtonStyle.Secondary,
		),
	);
	const uploadControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(
			CONFIGURE_RICH_PRESENCE_IMAGES_CUSTOM_ID,
			'URLs das imagens',
			ButtonStyle.Secondary,
		),
		button(
			CONFIGURE_RICH_PRESENCE_LARGE_IMAGE_CUSTOM_ID,
			'Upload img grande',
			ButtonStyle.Secondary,
		),
		button(
			CONFIGURE_RICH_PRESENCE_SMALL_IMAGE_CUSTOM_ID,
			'Upload img pequena',
			ButtonStyle.Secondary,
		),
	);
	const runtimeControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(START_RICH_PRESENCE_CUSTOM_ID, 'Ativar Rich', ButtonStyle.Success),
		button(STOP_RICH_PRESENCE_CUSTOM_ID, 'Desativar', ButtonStyle.Secondary),
		button(RESET_RICH_PRESENCE_CUSTOM_ID, 'Resetar Configs', ButtonStyle.Danger),
	);
	const tokenControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
		button(
			CONFIGURE_RICH_PRESENCE_TOKEN_CUSTOM_ID,
			'Configurar Token',
			ButtonStyle.Secondary,
			tokenConfigured,
		),
		button(
			CONFIGURE_RICH_PRESENCE_BUTTON_CUSTOM_ID,
			'Botao',
			ButtonStyle.Secondary,
		),
	);
	const typeSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		selectMenu(
			RICH_PRESENCE_ACTIVITY_TYPE_SELECT_CUSTOM_ID,
			`Tipo atual: ${richPresenceActivityTypeLabel(record.richPresenceConfig.activityType)}`,
			richPresenceActivityTypeOptions(),
		),
	);
	const lastUpdate = record.richPresenceUpdatedAt
		? formatUpdatedAt(record.richPresenceUpdatedAt)
		: 'Nunca';
	const container = new ContainerBuilder()
		.setAccentColor(PANEL_ACCENT)
		.addTextDisplayComponents(
			text(
				'# Personalizar Rich Presence\n' +
					'Ajuste os campos e clique em **Aplicar Configs** para refletir no Discord.',
			),
		)
		.addSeparatorComponents(separator())
		.addTextDisplayComponents(
			text(
				`**Status:** ${codeValue(richPresencePanelStatusLabel(record.richPresenceStatus))}\n` +
					`**Token:** ${codeValue(tokenLabel(tokenConfigured))}\n` +
					`**Timestamp da ultima atualizacao:** ${lastUpdate}`,
			),
		)
		.addSeparatorComponents(separator())
		.addTextDisplayComponents(
			text(richPresenceConfigLabel(record.richPresenceConfig)),
		)
		.addSeparatorComponents(separator())
		.addActionRowComponents(typeSelect)
		.addActionRowComponents(configControls)
		.addActionRowComponents(tokenControls)
		.addActionRowComponents(uploadControls)
		.addActionRowComponents(runtimeControls);

	return componentsV2Payload(container);
}

export class PersistentPanels {
	constructor(
		private readonly client: Client,
		private readonly store: PanelStore,
		private readonly userId: string,
		private readonly tokenConfigured: () => Promise<boolean>,
	) {}

	async ensureMainPanel(channelId: string): Promise<void> {
		const record = await this.store.getMainPanel();

		if (record.channelId && record.messageId) {
			try {
				await this.client.api.channels.editMessage(
					record.channelId,
					record.messageId,
					buildMainPanelPayload() as any,
				);
				return;
			} catch (error) {
				console.error('Main panel could not be edited, creating a new one:', error);
			}
		}

		const message = (await this.client.api.channels.createMessage(
			channelId,
			buildMainPanelPayload() as any,
		)) as any;

		await this.store.saveMainPanel({
			userId: this.userId,
			channelId,
			messageId: message.id,
		});
	}

	async ensureClearPanel(): Promise<UserPanelRecord> {
		return this.ensureUserPanel('clear');
	}

	async ensureMissionPanel(): Promise<UserPanelRecord> {
		return this.ensureUserPanel('mission');
	}

	async ensureVoicePanel(
		guildOptions: PanelSelectOption[] = [],
		channelOptions: PanelSelectOption[] = [],
	): Promise<UserPanelRecord> {
		return this.ensureUserPanel('voice', {
			guildOptions,
			channelOptions,
		});
	}

	async ensureRichPresencePanel(): Promise<UserPanelRecord> {
		return this.ensureUserPanel('richPresence');
	}

	async ensureUsernameCheckerPanel(): Promise<UserPanelRecord> {
		return this.ensureUserPanel('usernameChecker');
	}

	async updateClearPanel(
		patch: Partial<Omit<UserPanelRecord, 'userId'>>,
	): Promise<UserPanelRecord> {
		const record = await this.store.updateUser(this.userId, patch);
		return this.editOrCreateUserPanel('clear', record);
	}

	async updateMissionPanel(
		patch: Partial<Omit<UserPanelRecord, 'userId'>>,
	): Promise<UserPanelRecord> {
		const record = await this.store.updateUser(this.userId, patch);
		return this.editOrCreateUserPanel('mission', record);
	}

	async updateVoicePanel(
		patch: Partial<Omit<UserPanelRecord, 'userId'>>,
		guildOptions: PanelSelectOption[] = [],
		channelOptions: PanelSelectOption[] = [],
	): Promise<UserPanelRecord> {
		const record = await this.store.updateUser(this.userId, patch);
		return this.editOrCreateUserPanel('voice', record, {
			guildOptions,
			channelOptions,
		});
	}

	async updateRichPresencePanel(
		patch: Partial<Omit<UserPanelRecord, 'userId'>>,
	): Promise<UserPanelRecord> {
		const record = await this.store.updateUser(this.userId, patch);
		return this.editOrCreateUserPanel('richPresence', record);
	}

	async updateUsernameCheckerPanel(
		patch: Partial<Omit<UserPanelRecord, 'userId'>>,
	): Promise<UserPanelRecord> {
		const record = await this.store.updateUser(this.userId, patch);
		return this.editOrCreateUserPanel('usernameChecker', record);
	}

	async deleteBotDmMessages(): Promise<number> {
		const record = await this.store.getUser(this.userId);
		const currentUser = (await this.client.api.users.getCurrent()) as {
			id: string;
		};
		let deletedCount = 0;
		let dmChannelId = record.dmChannelId;

		if (!dmChannelId) {
			const dmChannel = (await this.client.api.users.createDM(
				this.userId,
			)) as any;
			dmChannelId = dmChannel.id;
		}

		if (dmChannelId) {
			const messages = await this.fetchAllDmMessages(dmChannelId);
			for (const message of messages) {
				if (message.author?.id !== currentUser.id) continue;

				try {
					await this.client.api.channels.deleteMessage(
						dmChannelId,
						message.id,
					);
					deletedCount += 1;
				} catch (error) {
					console.error(
						`Bot DM message ${message.id} could not be deleted:`,
						error,
					);
				}
			}
		}

		if (await this.store.hasUser(this.userId)) {
			await this.store.updateUser(this.userId, {
				dmChannelId: undefined,
				clearMessageId: undefined,
				missionMessageId: undefined,
				voiceMessageId: undefined,
				richPresenceMessageId: undefined,
				usernameCheckerMessageId: undefined,
			});
		}

		return deletedCount;
	}

	private async fetchAllDmMessages(channelId: string): Promise<BotDmMessage[]> {
		const messages: BotDmMessage[] = [];
		let before: string | undefined;
		let lastPageSize = PANEL_MESSAGE_FETCH_LIMIT;

		while (lastPageSize === PANEL_MESSAGE_FETCH_LIMIT) {
			const query = {
				limit: PANEL_MESSAGE_FETCH_LIMIT,
				...(before ? { before } : {}),
			};
			const page = (await this.client.api.channels.getMessages(
				channelId,
				query as any,
			)) as BotDmMessage[];

			lastPageSize = page.length;
			if (lastPageSize === 0) break;

			messages.push(...page);
			before = page[page.length - 1].id;
		}

		return messages;
	}

	private async ensureUserPanel(
		type: UserPanelType,
		options: Partial<VoicePanelPayloadOptions> = {},
	): Promise<UserPanelRecord> {
		const record = {
			...(await this.store.getUser(this.userId)),
			tokenConfigured: await this.tokenConfigured(),
		};
		return this.editOrCreateUserPanel(type, record, options);
	}

	private async editOrCreateUserPanel(
		type: UserPanelType,
		record: UserPanelRecord,
		options: Partial<VoicePanelPayloadOptions> = {},
		persistReference = true,
	): Promise<UserPanelRecord> {
		const messageId = this.messageIdForType(type, record);
		const payload = this.payloadForType(type, record, options);

		if (record.dmChannelId && messageId) {
			try {
				await this.client.api.channels.editMessage(
					record.dmChannelId,
					messageId,
					payload as any,
				);
				await this.deleteDuplicateUserPanels(
					type,
					record.dmChannelId,
					messageId,
				);
				return record;
			} catch (error) {
				console.error(`${type} panel could not be edited, creating a new one:`, error);
			}
		}

		const dmChannel = (await this.client.api.users.createDM(this.userId)) as any;
		const message = (await this.client.api.channels.createMessage(
			dmChannel.id,
			payload as any,
		)) as any;

		const panelPatch = {
			dmChannelId: dmChannel.id,
			...this.messagePatchForType(type, message.id),
		};

		if (persistReference) {
			const updatedRecord = await this.store.updateUser(this.userId, panelPatch);
			await this.deleteDuplicateUserPanels(type, dmChannel.id, message.id);
			return updatedRecord;
		}

		await this.deleteDuplicateUserPanels(type, dmChannel.id, message.id);
		return {
			...record,
			...panelPatch,
		};
	}

	private async deleteDuplicateUserPanels(
		type: UserPanelType,
		dmChannelId: string,
		keepMessageId: string,
	): Promise<void> {
		try {
			const currentUser = (await this.client.api.users.getCurrent()) as {
				id: string;
			};
			const messages = await this.fetchAllDmMessages(dmChannelId);
			const markerIds = new Set(this.markerCustomIdsForType(type));

			for (const message of messages) {
				if (message.id === keepMessageId) continue;
				if (message.author?.id !== currentUser.id) continue;
				if (!this.valueHasCustomId(message.components, markerIds)) continue;

				try {
					await this.client.api.channels.deleteMessage(
						dmChannelId,
						message.id,
					);
				} catch (error) {
					console.error(
						`Duplicate ${type} panel ${message.id} could not be deleted:`,
						error,
					);
				}
			}
		} catch (error) {
			console.error(`Duplicate ${type} panel cleanup failed:`, error);
		}
	}

	private markerCustomIdsForType(type: UserPanelType): string[] {
		switch (type) {
			case 'clear':
				return [
					START_CLEAR_CUSTOM_ID,
					DEACTIVATE_CLEAR_CUSTOM_ID,
					CONFIGURE_CLEAR_TOKEN_CUSTOM_ID,
					SET_CLEAR_BULK_MODE_CUSTOM_ID,
					SET_CLEAR_USER_DM_MODE_CUSTOM_ID,
					CONFIGURE_CLEAR_TARGET_USER_CUSTOM_ID,
				];
			case 'mission':
				return [
					START_MISSION_CUSTOM_ID,
					DEACTIVATE_MISSION_CUSTOM_ID,
					CONFIGURE_MISSION_TOKEN_CUSTOM_ID,
					MISSION_CONCURRENCY_SELECT_CUSTOM_ID,
				];
			case 'voice':
				return [
					VOICE_GUILD_SELECT_CUSTOM_ID,
					VOICE_CHANNEL_SELECT_CUSTOM_ID,
					START_VOICE_CUSTOM_ID,
					CHANGE_VOICE_CHANNEL_CUSTOM_ID,
					STOP_VOICE_CUSTOM_ID,
					CONFIGURE_VOICE_TOKEN_CUSTOM_ID,
				];
			case 'richPresence':
				return [
					CONFIGURE_RICH_PRESENCE_CUSTOM_ID,
					CONFIGURE_RICH_PRESENCE_BUTTON_CUSTOM_ID,
					CONFIGURE_RICH_PRESENCE_IMAGES_CUSTOM_ID,
					CONFIGURE_RICH_PRESENCE_ADVANCED_CUSTOM_ID,
					CONFIGURE_RICH_PRESENCE_LARGE_IMAGE_CUSTOM_ID,
					CONFIGURE_RICH_PRESENCE_SMALL_IMAGE_CUSTOM_ID,
					APPLY_RICH_PRESENCE_CUSTOM_ID,
					RESET_RICH_PRESENCE_CUSTOM_ID,
					RICH_PRESENCE_ACTIVITY_TYPE_SELECT_CUSTOM_ID,
					START_RICH_PRESENCE_CUSTOM_ID,
					STOP_RICH_PRESENCE_CUSTOM_ID,
					CONFIGURE_RICH_PRESENCE_TOKEN_CUSTOM_ID,
				];
			case 'usernameChecker':
				return [
					START_USERNAME_CHECKER_CUSTOM_ID,
					STOP_USERNAME_CHECKER_CUSTOM_ID,
					CONFIGURE_USERNAME_CHECKER_CUSTOM_ID,
				];
		}
	}

	private valueHasCustomId(value: unknown, customIds: Set<string>): boolean {
		if (Array.isArray(value)) {
			return value.some((item) => this.valueHasCustomId(item, customIds));
		}

		if (!value || typeof value !== 'object') return false;

		const record = value as Record<string, unknown>;
		if (
			typeof record.custom_id === 'string' &&
			customIds.has(record.custom_id)
		) {
			return true;
		}

		return Object.values(record).some((item) =>
			this.valueHasCustomId(item, customIds),
		);
	}

	private messageIdForType(
		type: UserPanelType,
		record: UserPanelRecord,
	): string | undefined {
		switch (type) {
			case 'clear':
				return record.clearMessageId;
			case 'mission':
				return record.missionMessageId;
			case 'voice':
				return record.voiceMessageId;
			case 'richPresence':
				return record.richPresenceMessageId;
			case 'usernameChecker':
				return record.usernameCheckerMessageId;
		}
	}

	private messagePatchForType(
		type: UserPanelType,
		messageId: string,
	): Partial<Omit<UserPanelRecord, 'userId'>> {
		switch (type) {
			case 'clear':
				return { clearMessageId: messageId };
			case 'mission':
				return { missionMessageId: messageId };
			case 'voice':
				return { voiceMessageId: messageId };
			case 'richPresence':
				return { richPresenceMessageId: messageId };
			case 'usernameChecker':
				return { usernameCheckerMessageId: messageId };
		}
	}

	private payloadForType(
		type: UserPanelType,
		record: UserPanelRecord,
		options: Partial<VoicePanelPayloadOptions>,
	): Record<string, unknown> {
		switch (type) {
			case 'clear':
				return buildClearPanelPayload({
					record,
					tokenConfigured: record.tokenConfigured,
				});
			case 'mission':
				return buildMissionPanelPayload({
					record,
					tokenConfigured: record.tokenConfigured,
				});
			case 'voice':
				return buildVoicePanelPayload({
					record,
					tokenConfigured: record.tokenConfigured,
					guildOptions: options.guildOptions,
					channelOptions: options.channelOptions,
				});
			case 'richPresence':
				return buildRichPresencePanelPayload({
					record,
					tokenConfigured: record.tokenConfigured,
				});
			case 'usernameChecker':
				return buildUsernameCheckerPanelPayload({
					record,
				});
		}
	}
}
