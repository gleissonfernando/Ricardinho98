import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type Interaction,
  type StringSelectMenuInteraction
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";

const MODULE_ID = "police-flight";
const PREFIX = "police_flight";

type FlightConfig = {
  enabled: boolean;
  panelChannelId: string | null;
  panelMessageId: string | null;
  logChannelId: string | null;
  allowedRoleIds: string[];
  pilotRoleIds: string[];
  shooterRoleIds: string[];
  closeRoleIds: string[];
  adminRoleIds: string[];
  titleText: string;
  descriptionText: string;
  pilotText: string;
  shooterText: string;
  enterButtonText: string;
  closeButtonText: string;
  enterButtonEmoji: string;
  closeButtonEmoji: string;
  embedColor: string;
  allowReplaceOccupiedRole: boolean;
  maxPilots: number;
  maxShooters: number;
  status: "open" | "closed";
  openedBy: string | null;
  openedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  pilotIds: string[];
  shooterIds: string[];
};

export function startPoliceFlightService(client: Client<true>, context: BotContext) {
  context.socket.onPoliceFlightPanelUpdate((payload) => {
    if (payload.botId && currentRuntimeBotId() && payload.botId !== currentRuntimeBotId()) return;
    const guild = client.guilds.cache.get(payload.guildId);
    if (guild) void publishPoliceFlightPanel(guild, context).catch((error) => {
      console.warn("[police-flight] falha ao publicar painel:", error instanceof Error ? error.message : error);
    });
  });
}

export async function handlePoliceFlightInteraction(interaction: Interaction, context: BotContext) {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guild || !isBotModuleEnabled(MODULE_ID)) return true;
  const config = await loadConfig(interaction.guild.id, context);
  if (!config.enabled) {
    await replyHidden(interaction, "Sistema de Escalacao de Voo desativado.");
    return true;
  }
  const action = interaction.customId.split(":")[1];
  if (interaction.isButton() && action === "enter") {
    await showRoleSelect(interaction, config);
    return true;
  }
  if (interaction.isStringSelectMenu() && action === "role") {
    await joinRole(interaction, context, config, interaction.values[0] === "pilot" ? "pilot" : "shooter");
    return true;
  }
  if (interaction.isButton() && action === "close") {
    await closeOrLeave(interaction, context, config);
    return true;
  }
  await replyHidden(interaction, "Acao da escalacao invalida.");
  return true;
}

async function publishPoliceFlightPanel(guild: Guild, context: BotContext) {
  const config = await loadConfig(guild.id, context);
  if (!config.enabled || !config.panelChannelId) throw new Error("Escalacao de voo sem canal ou desativada.");
  const channel = await guild.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error("Canal do painel invalido.");
  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  const payload = panelPayload(config);
  if (message) {
    await message.edit(payload);
  } else {
    message = await channel.send(payload);
  }
  if (message.id !== config.panelMessageId) await context.api.updatePoliceFlightState(guild.id, { panelMessageId: message.id });
  await sendLog(guild, config, "Painel enviado", null, null);
}

async function showRoleSelect(interaction: ButtonInteraction, config: FlightConfig) {
  if (!hasAnyRole(interaction, [...config.allowedRoleIds, ...config.pilotRoleIds, ...config.shooterRoleIds, ...config.adminRoleIds])) {
    await replyHidden(interaction, "Voce nao tem permissao para usar este sistema.");
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:role`)
    .setPlaceholder("Escolha sua funcao na escalacao")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Piloto").setDescription("Responsavel pelo voo").setValue("pilot").setEmoji("✈️"),
      new StringSelectMenuOptionBuilder().setLabel("Atirador").setDescription("Responsavel pela cobertura").setValue("shooter").setEmoji("🎯")
    );
  await interaction.reply({
    components: [{ type: 17, accent_color: color(config.embedColor), components: [{ type: 10, content: "## Entrar na Escalacao de Voo\nSelecione a funcao que deseja assumir." }, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

async function joinRole(interaction: StringSelectMenuInteraction, context: BotContext, config: FlightConfig, role: "pilot" | "shooter") {
  const roleIds = role === "pilot" ? config.pilotRoleIds : config.shooterRoleIds;
  if (!hasAnyRole(interaction, [...config.allowedRoleIds, ...roleIds, ...config.adminRoleIds])) {
    await replyHidden(interaction, "Voce nao tem permissao para usar este sistema.");
    return;
  }
  if (config.status === "closed") {
    config.status = "open";
    config.openedBy = interaction.user.id;
    config.openedAt = new Date().toISOString();
    config.closedBy = null;
    config.closedAt = null;
  }
  if (config.pilotIds.includes(interaction.user.id) || config.shooterIds.includes(interaction.user.id)) {
    await replyHidden(interaction, `Voce ja esta escalado como ${config.pilotIds.includes(interaction.user.id) ? "Piloto" : "Atirador"}.`);
    return;
  }
  const key = role === "pilot" ? "pilotIds" : "shooterIds";
  const limit = role === "pilot" ? config.maxPilots : config.maxShooters;
  if (config[key].length >= limit && !config.allowReplaceOccupiedRole) {
    await replyHidden(interaction, "Esta funcao ja esta ocupada.");
    return;
  }
  config[key] = config.allowReplaceOccupiedRole ? [interaction.user.id] : [...config[key], interaction.user.id].slice(0, limit);
  const saved = await context.api.updatePoliceFlightState(interaction.guildId!, {
    status: config.status,
    openedBy: config.openedBy,
    openedAt: config.openedAt,
    closedBy: null,
    closedAt: null,
    pilotIds: config.pilotIds,
    shooterIds: config.shooterIds
  });
  await refreshPanel(interaction.guild!, context, normalizeConfig(saved.config));
  await sendLog(interaction.guild!, normalizeConfig(saved.config), role === "pilot" ? "Usuario entrou como Piloto" : "Usuario entrou como Atirador", interaction.user.id, role);
  await replyHidden(interaction, `Voce entrou na escalacao como ${role === "pilot" ? "Piloto" : "Atirador"}.`);
}

async function closeOrLeave(interaction: ButtonInteraction, context: BotContext, config: FlightConfig) {
  const isPilot = config.pilotIds.includes(interaction.user.id);
  const isShooter = config.shooterIds.includes(interaction.user.id);
  const canCloseAll = hasAnyRole(interaction, [...config.closeRoleIds, ...config.adminRoleIds]);
  if (!isPilot && !isShooter && !canCloseAll) {
    await replyHidden(interaction, "Voce nao esta escalado em nenhuma funcao.");
    return;
  }
  if (canCloseAll) {
    config.status = "closed";
    config.closedBy = interaction.user.id;
    config.closedAt = new Date().toISOString();
    config.pilotIds = [];
    config.shooterIds = [];
  } else {
    config.pilotIds = config.pilotIds.filter((id) => id !== interaction.user.id);
    config.shooterIds = config.shooterIds.filter((id) => id !== interaction.user.id);
  }
  const saved = await context.api.updatePoliceFlightState(interaction.guildId!, {
    status: config.status,
    closedBy: config.closedBy,
    closedAt: config.closedAt,
    pilotIds: config.pilotIds,
    shooterIds: config.shooterIds
  });
  await refreshPanel(interaction.guild!, context, normalizeConfig(saved.config));
  await sendLog(interaction.guild!, normalizeConfig(saved.config), canCloseAll ? "Escalacao fechada" : "Usuario saiu da escalacao", interaction.user.id, null);
  await replyHidden(interaction, canCloseAll ? "Escalacao fechada." : "Voce saiu da escalacao.");
}

async function refreshPanel(guild: Guild, context: BotContext, config: FlightConfig) {
  if (!config.panelChannelId || !config.panelMessageId) return;
  const channel = await guild.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(config.panelMessageId).catch(() => null);
  if (message) await message.edit(panelPayload(config)).catch(() => null);
}

function panelPayload(config: FlightConfig) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:enter`).setLabel(config.enterButtonText).setEmoji(config.enterButtonEmoji || "🛫").setStyle(ButtonStyle.Primary).setDisabled(config.status === "closed" && Boolean(config.closedAt)),
    new ButtonBuilder().setCustomId(`${PREFIX}:close`).setLabel(config.closeButtonText).setEmoji(config.closeButtonEmoji || "🔒").setStyle(ButtonStyle.Danger)
  );
  const opened = config.openedAt ? `<t:${Math.floor(new Date(config.openedAt).getTime() / 1000)}:f> por <@${config.openedBy}>` : "Ainda nao aberta";
  return {
    allowedMentions: { parse: [] as never[] },
    components: [{
      type: 17,
      accent_color: color(config.embedColor),
      components: [
        { type: 10, content: `**North Police Department · DAF**\n\n# ${config.titleText}\n${config.descriptionText}\n\n**Status:** ${config.status === "open" ? "Aberta" : "Fechada"}\n**Abertura:** ${opened}` },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: `## ✈️ Piloto\n${config.pilotText}\n${config.pilotIds.length ? config.pilotIds.map((id) => `<@${id}>`).join("\n") : "Nenhum piloto escalado."}` },
        { type: 10, content: `## 🎯 Atirador\n${config.shooterText}\n${config.shooterIds.length ? config.shooterIds.map((id) => `<@${id}>`).join("\n") : "Nenhum atirador escalado."}` },
        buttons
      ]
    }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

async function loadConfig(guildId: string, context: BotContext) {
  const botId = currentRuntimeBotId();
  if (!botId) return defaultConfig();
  const runtime = await context.api.getBotGuildConfig(botId, guildId);
  return normalizeConfig(runtime.modules[MODULE_ID] ?? {});
}

function normalizeConfig(raw: Record<string, unknown>): FlightConfig {
  return {
    ...defaultConfig(),
    enabled: raw.enabled === true,
    panelChannelId: str(raw.panelChannelId),
    panelMessageId: str(raw.panelMessageId),
    logChannelId: str(raw.logChannelId),
    allowedRoleIds: ids(raw.allowedRoleIds),
    pilotRoleIds: ids(raw.pilotRoleIds),
    shooterRoleIds: ids(raw.shooterRoleIds),
    closeRoleIds: ids(raw.closeRoleIds),
    adminRoleIds: ids(raw.adminRoleIds),
    titleText: str(raw.titleText) ?? defaultConfig().titleText,
    descriptionText: str(raw.descriptionText) ?? defaultConfig().descriptionText,
    pilotText: str(raw.pilotText) ?? defaultConfig().pilotText,
    shooterText: str(raw.shooterText) ?? defaultConfig().shooterText,
    enterButtonText: str(raw.enterButtonText) ?? defaultConfig().enterButtonText,
    closeButtonText: str(raw.closeButtonText) ?? defaultConfig().closeButtonText,
    enterButtonEmoji: str(raw.enterButtonEmoji) ?? "🛫",
    closeButtonEmoji: str(raw.closeButtonEmoji) ?? "🔒",
    embedColor: str(raw.embedColor) ?? "#3b82f6",
    allowReplaceOccupiedRole: raw.allowReplaceOccupiedRole === true,
    maxPilots: Math.max(1, Number(raw.maxPilots) || 1),
    maxShooters: Math.max(1, Number(raw.maxShooters) || 1),
    status: raw.status === "closed" ? "closed" : "open",
    openedBy: str(raw.openedBy),
    openedAt: str(raw.openedAt),
    closedBy: str(raw.closedBy),
    closedAt: str(raw.closedAt),
    pilotIds: ids(raw.pilotIds),
    shooterIds: ids(raw.shooterIds)
  };
}

function defaultConfig(): FlightConfig {
  return {
    enabled: false,
    panelChannelId: null,
    panelMessageId: null,
    logChannelId: null,
    allowedRoleIds: [],
    pilotRoleIds: [],
    shooterRoleIds: [],
    closeRoleIds: [],
    adminRoleIds: [],
    titleText: "🚁 PAINEL DE ESCALACAO DE VOO — DAF",
    descriptionText: "Use os botoes abaixo para abrir uma nova escalacao de voo.\nApos aberto, os membros assumem as posicoes de Piloto e Atirador.\n\nAo finalizar, clique em Fechar Escalacao para encerrar e registrar.",
    pilotText: "Responsavel pelo voo",
    shooterText: "Responsavel pela cobertura",
    enterButtonText: "Abrir Escalacao de Voo",
    closeButtonText: "Fechar Escalacao",
    enterButtonEmoji: "🛫",
    closeButtonEmoji: "🔒",
    embedColor: "#3b82f6",
    allowReplaceOccupiedRole: false,
    maxPilots: 1,
    maxShooters: 1,
    status: "open",
    openedBy: null,
    openedAt: null,
    closedBy: null,
    closedAt: null,
    pilotIds: [],
    shooterIds: []
  };
}

async function sendLog(guild: Guild, config: FlightConfig, action: string, userId: string | null, role: string | null) {
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({
    allowedMentions: { parse: [] },
    components: [{ type: 17, accent_color: color(config.embedColor), components: [{ type: 10, content: `# LOG — Escalacao de Voo\n**Acao:** ${action}\n**Usuario:** ${userId ? `<@${userId}>` : "Sistema"}\n**Funcao:** ${role ?? "N/A"}\n**Piloto atual:** ${config.pilotIds.map((id) => `<@${id}>`).join(", ") || "Nenhum"}\n**Atirador atual:** ${config.shooterIds.map((id) => `<@${id}>`).join(", ") || "Nenhum"}\n**Data/Hora:** <t:${Math.floor(Date.now() / 1000)}:F>` }] }],
    flags: MessageFlags.IsComponentsV2
  }).catch(() => null);
}

function hasAnyRole(interaction: ButtonInteraction | StringSelectMenuInteraction, roleIds: string[]) {
  if (!roleIds.length) return true;
  const memberRoles = interaction.member?.roles;
  if (!memberRoles || typeof memberRoles === "string") return false;
  return roleIds.some((id) => memberRoles.cache.has(id));
}
async function replyHidden(interaction: ButtonInteraction | StringSelectMenuInteraction | Interaction, content: string) {
  if (!interaction.isRepliable()) return;
  const payload = { content, ephemeral: true } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
  else await interaction.reply(payload).catch(() => null);
}
function str(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function ids(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function color(value: string) { const hex = value.replace("#", ""); return /^[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex, 16) : 0x3b82f6; }
