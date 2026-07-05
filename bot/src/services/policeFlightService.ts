import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";
import { renderComponentsV2Panel, resolvePanelImageUrl, type PanelVisualPosition } from "./panelVisualRenderer";

const MODULE_ID = "police-flight";
const PREFIX = "police_flight";
const CONFIG_PREFIX = "police_flight_config";
const dafPublishQueues = new Map<string, Promise<unknown>>();

type FlightRole = "pilot" | "shooter";

type FlightConfig = {
  enabled: boolean;
  panelChannelId: string | null;
  panelChannelIds: string[];
  panelMessageId: string | null;
  panelMessageChannelId: string | null;
  logChannelId: string | null;
  logChannelIds: string[];
  categoryId: string | null;
  categoryIds: string[];
  allowedRoleIds: string[];
  dafRoleIds: string[];
  pilotRoleIds: string[];
  shooterRoleIds: string[];
  closeRoleIds: string[];
  adminRoleIds: string[];
  titleText: string;
  descriptionText: string;
  panelFooter: string;
  panelImage: string | null;
  pilotText: string;
  shooterText: string;
  enterPilotButtonText: string;
  enterShooterButtonText: string;
  enterButtonText: string;
  leaveButtonText: string;
  enterButtonEmoji: string;
  leaveButtonEmoji: string;
  closeButtonEmoji: string;
  closeButtonText: string;
  embedColor: string;
  allowSameUserBothFunctions: boolean;
  allowReplaceOccupiedRole: boolean;
  maxPilots: number;
  maxShooters: number;
  scaleId: number;
  status: "open" | "closed";
  openedBy: string | null;
  openedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  pilotIds: string[];
  shooterIds: string[];
};

export function startPoliceFlightService(client: Client<true>, context: BotContext) {
  context.socket.onPoliceFlightPanelUpdate((payload, acknowledge) => {
    if (payload.botId && currentRuntimeBotId() && payload.botId !== currentRuntimeBotId()) {
      acknowledge?.({ error: "Evento destinado a outro bot." });
      return;
    }
    void publishDafPanel(client, context, payload.guildId, payload.source ?? "automatic")
      .then((result) => acknowledge?.({ ok: true, ...result }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[police-flight] falha ao publicar painel:", message);
        acknowledge?.({ error: message });
      });
  });
}

export async function showPoliceFlightConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) {
    await safeReply(interaction, "Use este comando dentro de um servidor.");
    return;
  }
  const config = await loadConfig(interaction.guild.id, context);
  if (!(await canManageConfig(interaction, config))) {
    await safeReply(interaction, "Voce nao tem permissao para configurar o sistema da DAF.");
    return;
  }
  await safeReply(interaction, {
    components: configPanelPayload(config),
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

export async function handlePoliceFlightInteraction(interaction: Interaction, context: BotContext) {
  const isRuntimeInteraction = (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit())
    && (interaction.customId.startsWith(`${PREFIX}:`) || interaction.customId.startsWith(`${CONFIG_PREFIX}:`));
  if (!isRuntimeInteraction) return false;
  if (!interaction.guild) {
    await safeReply(interaction, "Esta interacao so funciona dentro de um servidor.");
    return true;
  }
  if (!isBotModuleEnabled(MODULE_ID)) {
    await safeReply(interaction, "Sistema de Escalacao DAF indisponivel neste bot.");
    return true;
  }

  const action = interaction.customId.split(":")[1] ?? "";
  const opensModal = interaction.isButton()
    && interaction.customId.startsWith(`${CONFIG_PREFIX}:`)
    && action === "texts";
  if (!opensModal) {
    await deferEphemeral(interaction);
  }
  const config = await loadConfig(interaction.guild.id, context);

  if (interaction.customId.startsWith(`${CONFIG_PREFIX}:`)) {
    await handleConfigInteraction(interaction, context, config, action);
    return true;
  }

  if (!config.enabled) {
    await safeReply(interaction, "Sistema de Escalacao DAF desativado.");
    return true;
  }

  if (interaction.isButton() && action === "join") {
    await showJoinCategorySelect(interaction);
    return true;
  }
  if (interaction.isStringSelectMenu() && action === "join_category") {
    const role = parseFlightRole(interaction.values[0] ?? "");
    if (!role) {
      await editDeferred(interaction, "Categoria invalida. Selecione Piloto ou Atirador.");
      return true;
    }
    await joinRole(interaction, context, config, role);
    return true;
  }
  if (interaction.isButton() && action === "leave") {
    await leaveScale(interaction, context, config);
    return true;
  }
  if (interaction.isButton() && action === "close") {
    await closeScale(interaction, context, config);
    return true;
  }

  await safeReply(interaction, "Acao da escalacao invalida.");
  return true;
}

async function handleConfigInteraction(interaction: Interaction, context: BotContext, config: FlightConfig, action: string) {
  if (!interaction.guild || !(await canManageConfig(interaction, config))) {
    await safeReply(interaction, "Voce nao tem permissao para configurar o sistema da DAF.");
    return;
  }

  if (interaction.isButton() && action === "publish") {
    await deferEphemeral(interaction);
    try {
      const result = await publishDafPanel(interaction.client, context, interaction.guild.id, "command", interaction.user.id);
      await editDeferred(interaction, `Painel DAF publicado com sucesso em #${result.channelName}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await editDeferred(interaction, `Nao foi possivel publicar o painel DAF: ${message}`);
    }
    return;
  }
  if (interaction.isButton() && action === "reset") {
    await deferEphemeral(interaction);
    const saved = await context.api.updatePoliceFlightState(interaction.guild.id, {
      pilotIds: [],
      shooterIds: [],
      status: "open",
      closedBy: null,
      closedAt: null,
      openedBy: interaction.user.id,
      openedAt: new Date().toISOString()
    });
    await refreshPanel(interaction.guild, context, normalizeDafConfig(saved.config));
    await editDeferred(interaction, "Escalacao atual resetada.");
    return;
  }
  if (interaction.isButton() && action === "test_log") {
    await deferEphemeral(interaction);
    await sendScaleLog(interaction.guild, config, { ...config, closedBy: interaction.user.id, closedAt: new Date().toISOString() }, true);
    await editDeferred(interaction, config.logChannelId ? "Log de teste enviado." : "Configure o canal de logs antes de testar.");
    return;
  }
  if (interaction.isButton() && action === "texts") {
    await interaction.showModal(textModal(config));
    return;
  }
  if (interaction.isModalSubmit() && action === "texts") {
    await deferEphemeral(interaction);
    const saved = await context.api.updatePoliceFlightState(interaction.guild.id, {
      titleText: interaction.fields.getTextInputValue("titleText"),
      descriptionText: interaction.fields.getTextInputValue("descriptionText"),
      panelFooter: interaction.fields.getTextInputValue("panelFooter")
    });
    await refreshPanel(interaction.guild, context, normalizeDafConfig(saved.config));
    await editDeferred(interaction, "Textos do painel DAF atualizados.");
    return;
  }
  if (interaction.isRoleSelectMenu() && action === "daf_roles") {
    await updateConfigFromSelect(interaction, context, { dafRoleIds: interaction.values, pilotRoleIds: interaction.values, shooterRoleIds: interaction.values });
    return;
  }
  if (interaction.isRoleSelectMenu() && action === "allowed_roles") {
    await updateConfigFromSelect(interaction, context, { allowedRoleIds: interaction.values, adminRoleIds: interaction.values, closeRoleIds: interaction.values });
    return;
  }
  if (interaction.isChannelSelectMenu() && action === "panel_channel") {
    await updateConfigFromSelect(interaction, context, { panelChannelIds: interaction.values, panelChannelId: interaction.values[0] ?? null });
    return;
  }
  if (interaction.isChannelSelectMenu() && action === "log_channel") {
    await updateConfigFromSelect(interaction, context, { logChannelIds: interaction.values, logChannelId: interaction.values[0] ?? null });
    return;
  }
  if (interaction.isChannelSelectMenu() && action === "category") {
    await updateConfigFromSelect(interaction, context, { categoryIds: interaction.values, categoryId: interaction.values[0] ?? null });
    return;
  }

  await safeReply(interaction, "Opcao de configuracao DAF invalida.");
}

async function updateConfigFromSelect(interaction: RoleSelectMenuInteraction | ChannelSelectMenuInteraction, context: BotContext, patch: Record<string, unknown>) {
  await deferEphemeral(interaction);
  const saved = await context.api.updatePoliceFlightState(interaction.guildId!, patch);
  if (interaction.guild) {
    await refreshPanel(interaction.guild, context, normalizeDafConfig(saved.config));
  }
  await editDeferred(interaction, "Configuracao DAF salva.");
}

export async function publishDafPanel(
  client: Client,
  context: BotContext,
  guildId: string,
  source: "dashboard" | "command" | "automatic",
  openedByUserId: string | null = null
) {
  const queueKey = `${currentRuntimeBotId() ?? "unknown"}:${guildId}`;
  const previous = dafPublishQueues.get(queueKey) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => publishDafPanelUnlocked(client, context, guildId, source, openedByUserId));
  dafPublishQueues.set(queueKey, current);
  return current.finally(() => {
    if (dafPublishQueues.get(queueKey) === current) dafPublishQueues.delete(queueKey);
  });
}

async function publishDafPanelUnlocked(
  client: Client,
  context: BotContext,
  guildId: string,
  source: "dashboard" | "command" | "automatic",
  openedByUserId: string | null
) {
  const botId = currentRuntimeBotId();
  if (!botId) throw new Error("Configuracao DAF nao encontrada: botId nao identificado.");
  if (!client.user) throw new Error("Bot Discord ainda nao esta pronto para publicar o painel DAF.");
  const guild = await client.guilds.fetch(guildId).catch((error) => {
    logDafPublishError({ botId, channelId: null, error, guildId, source });
    return null;
  });
  if (!guild) throw new Error("Configuracao DAF nao encontrada para este servidor e bot.");
  let config = await loadConfig(guild.id, context, true);
  if (!config.enabled) throw new Error("Escalacao DAF desativada.");
  const panelChannelId = config.panelChannelId;
  if (!panelChannelId) throw new Error("Canal nao configurado para o painel DAF.");
  const channel = await client.channels.fetch(panelChannelId).catch((error) => {
    logDafPublishError({ botId, channelId: panelChannelId, error, guildId, source });
    return null;
  });
  if (!channel || !("guildId" in channel) || channel.guildId !== guildId) {
    throw new Error("Canal DAF nao encontrado no servidor configurado.");
  }
  if (!channel.isTextBased() || !("send" in channel) || !("messages" in channel)) {
    throw new Error("O canal selecionado nao suporta envio de mensagens.");
  }

  const permissions = channel.permissionsFor(client.user);
  const permissionState = {
    attachFiles: Boolean(permissions?.has(PermissionFlagsBits.AttachFiles)),
    embedLinks: Boolean(permissions?.has(PermissionFlagsBits.EmbedLinks)),
    sendMessages: Boolean(permissions?.has(PermissionFlagsBits.SendMessages)),
    viewChannel: Boolean(permissions?.has(PermissionFlagsBits.ViewChannel))
  };
  console.info("[police-flight] publicacao DAF", {
    botId,
    channelId: panelChannelId,
    channelName: "name" in channel ? channel.name : panelChannelId,
    guildId,
    permissions: permissionState,
    source
  });
  const image = await loadDafPanelImage(guildId, context, config.panelImage);
  const requiredPermissions = [
    permissionState.viewChannel,
    permissionState.sendMessages,
    permissionState.embedLinks
  ];
  if (requiredPermissions.some((allowed) => !allowed)) {
    logDafPublishError({
      botId,
      channelId: panelChannelId,
      channelName: channel.name,
      error: new Error("Permissoes insuficientes para publicar o painel DAF."),
      guildId,
      permissions: permissionState,
      source
    });
    throw new Error("O bot não tem permissão para publicar no canal selecionado. Verifique: Ver Canal, Enviar Mensagens e Usar Componentes/Embeds.");
  }

  if (!config.openedAt) {
    const saved = await context.api.updatePoliceFlightState(guild.id, {
      status: "open",
      openedBy: openedByUserId,
      openedAt: new Date().toISOString(),
      closedBy: null,
      closedAt: null,
      pilotIds: [],
      shooterIds: [],
      scaleId: config.scaleId
    });
    config = normalizeDafConfig(saved.config);
  }

  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  const previousMessage = config.panelMessageId && config.panelMessageChannelId && config.panelMessageChannelId !== panelChannelId
    ? await fetchDafPanelMessage(client, config.panelMessageChannelId, config.panelMessageId)
    : null;
  const sendOrEdit = async (imageUrl: string | null) => {
    const payload = await panelPayload(guild, config, imageUrl ? { position: image.position, url: imageUrl } : null);
    return message ? message.edit(payload) : channel.send(payload);
  };
  try {
    message = await sendOrEdit(image.url);
  } catch (error) {
    if (!image.url || !isInvalidImageError(error)) {
      logDafPublishError({ botId, channelId: panelChannelId, channelName: channel.name, error, guildId, permissions: permissionState, source });
      throw new Error(`Erro ao enviar mensagem DAF: ${discordErrorMessage(error)}`);
    }
    console.warn("[police-flight] imagem DAF rejeitada; publicando sem imagem", {
      botId, channelId: panelChannelId, guildId, imageUrl: image.url, source, error: discordErrorMessage(error)
    });
    try {
      message = await sendOrEdit(null);
    } catch (retryError) {
      logDafPublishError({ botId, channelId: panelChannelId, channelName: channel.name, error: retryError, guildId, permissions: permissionState, source });
      throw new Error(`Erro ao enviar mensagem DAF: ${discordErrorMessage(retryError)}`);
    }
  }
  if (message.id !== config.panelMessageId || config.panelMessageChannelId !== panelChannelId) {
    await context.api.updatePoliceFlightState(guild.id, {
      panelMessageChannelId: panelChannelId,
      panelMessageId: message.id
    });
  }
  if (previousMessage && previousMessage.id !== message.id) {
    await previousMessage.delete().catch((error) => {
      console.warn("[police-flight] painel DAF antigo nao pôde ser removido", {
        botId, channelId: config.panelMessageChannelId, error: discordErrorMessage(error), guildId, messageId: previousMessage.id, source
      });
    });
  }
  return {
    channelId: panelChannelId,
    channelName: channel.name,
    messageId: message.id
  };
}

async function joinRole(interaction: StringSelectMenuInteraction, context: BotContext, config: FlightConfig, role: FlightRole) {
  const member = await ensureGuildMember(interaction);
  if (!member) {
    await editDeferred(interaction, "Nao foi possivel localizar seu membro no servidor.");
    return;
  }
  if (!hasAnyRole(member, allowedParticipantRoles(config, role))) {
    await editDeferred(interaction, "Voce nao possui permissao para participar da escalacao da DAF.");
    return;
  }
  if (!config.panelChannelId || !config.panelMessageId) {
    console.warn("[police-flight] painel ausente ou nao configurado", { guildId: interaction.guildId });
    await editDeferred(interaction, "Configure e publique o painel da DAF antes de usar a escala.");
    return;
  }

  if (config.status === "closed") {
    await editDeferred(interaction, "Esta escalacao ja foi encerrada.");
    return;
  }

  if (!config.openedAt) {
    config.status = "open";
    config.openedBy = interaction.user.id;
    config.openedAt = new Date().toISOString();
    config.closedBy = null;
    config.closedAt = null;
  }

  const alreadyPilot = config.pilotIds.includes(interaction.user.id);
  const alreadyShooter = config.shooterIds.includes(interaction.user.id);
  if ((role === "pilot" && alreadyPilot) || (role === "shooter" && alreadyShooter)) {
    await editDeferred(interaction, `Voce ja esta na escala como ${role === "pilot" ? "Piloto" : "Atirador"}.`);
    return;
  }
  if (alreadyPilot || alreadyShooter) {
    await editDeferred(interaction, "Voce ja ocupa uma categoria nesta escalacao. Saia da escalacao antes de entrar em outra categoria.");
    return;
  }

  const key = role === "pilot" ? "pilotIds" : "shooterIds";
  const maxSlots = role === "pilot" ? config.maxPilots : config.maxShooters;
  const currentIds = uniqueIds(config[key]);
  if (currentIds.length >= maxSlots) {
    await editDeferred(interaction, `As vagas de ${role === "pilot" ? "Piloto" : "Atirador"} ja estao preenchidas.`);
    return;
  }
  config[key] = [...currentIds, interaction.user.id].slice(0, maxSlots);

  const saved = await context.api.updatePoliceFlightState(interaction.guildId!, {
    status: config.status,
    openedBy: config.openedBy,
    openedAt: config.openedAt,
    closedBy: null,
    closedAt: null,
    pilotIds: config.pilotIds,
    shooterIds: config.shooterIds
  });
  const savedConfig = normalizeDafConfig(saved.config);
  await refreshPanel(interaction.guild!, context, savedConfig);
  await editDeferred(interaction, `Voce entrou na escala como ${role === "pilot" ? "Piloto" : "Atirador"}.`);
}

async function leaveScale(interaction: ButtonInteraction, context: BotContext, config: FlightConfig) {
  const member = await ensureGuildMember(interaction);
  if (!member) {
    await editDeferred(interaction, "Nao foi possivel localizar seu membro no servidor.");
    return;
  }
  if (config.status === "closed") {
    await editDeferred(interaction, "Esta escalacao ja foi encerrada.");
    return;
  }
  if (!config.panelChannelId || !config.panelMessageId) {
    await editDeferred(interaction, "Configure e publique o painel da DAF antes de usar a escala.");
    return;
  }

  const wasPilot = config.pilotIds.includes(interaction.user.id);
  const wasShooter = config.shooterIds.includes(interaction.user.id);
  if (!wasPilot && !wasShooter) {
    await editDeferred(interaction, "Voce nao esta em nenhuma categoria desta escalacao.");
    return;
  }

  const saved = await context.api.updatePoliceFlightState(interaction.guildId!, {
    pilotIds: config.pilotIds.filter((id) => id !== interaction.user.id),
    shooterIds: config.shooterIds.filter((id) => id !== interaction.user.id)
  });
  await sendParticipantLeaveLog(interaction.guild!, config, interaction.user.id, wasPilot ? "pilot" : "shooter");
  await refreshPanel(interaction.guild!, context, normalizeDafConfig(saved.config));
  await editDeferred(interaction, `Voce saiu da escala de ${wasPilot ? "Piloto" : "Atirador"}.`);
}

async function closeScale(interaction: ButtonInteraction, context: BotContext, config: FlightConfig) {
  const member = await ensureGuildMember(interaction);
  if (!member) {
    await editDeferred(interaction, "Nao foi possivel localizar seu membro no servidor.");
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    && !canCloseScale(member, config)) {
    await editDeferred(interaction, "Voce nao possui permissao para encerrar a escalacao da DAF.");
    return;
  }
  if (config.status === "closed") {
    await editDeferred(interaction, "Esta escalacao ja foi encerrada.");
    return;
  }

  const finalConfig = {
    ...config,
    status: "closed" as const,
    closedBy: interaction.user.id,
    closedAt: new Date().toISOString()
  };
  const savedClosed = await context.api.updatePoliceFlightState(interaction.guildId!, {
    status: "closed",
    closedBy: finalConfig.closedBy,
    closedAt: finalConfig.closedAt,
    pilotIds: finalConfig.pilotIds,
    shooterIds: finalConfig.shooterIds
  });
  const closedConfig = normalizeDafConfig(savedClosed.config);
  await sendScaleLog(interaction.guild!, config, closedConfig, false);
  await refreshPanel(interaction.guild!, context, closedConfig);
  await editDeferred(interaction, "Escalacao encerrada, bloqueada e registrada.");
}

async function refreshPanel(guild: Guild, context: BotContext, config: FlightConfig) {
  const panelChannelId = config.panelChannelId;
  if (!panelChannelId || !config.panelMessageId) {
    console.warn("[police-flight] nao foi possivel atualizar painel: canal ou mensagem ausente", { guildId: guild.id });
    return;
  }
  const channel = await guild.channels.fetch(panelChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(config.panelMessageId).catch(() => null);
  const image = await loadDafPanelImage(guild.id, context, config.panelImage);
  if (message) await message.edit(await panelPayload(guild, config, image.url ? { position: image.position, url: image.url } : null)).catch((error) => {
    console.warn("[police-flight] falha ao editar painel:", error instanceof Error ? error.message : error);
  });
}

async function panelPayload(guild: Guild, config: FlightConfig, image: { position: PanelVisualPosition; url: string } | null) {
  const closed = config.status === "closed";
  const memberNames = await loadMemberNames(guild, [...config.pilotIds, ...config.shooterIds]);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    applyButtonEmoji(new ButtonBuilder().setCustomId(`${PREFIX}:join`).setLabel(config.enterButtonText).setStyle(ButtonStyle.Primary).setDisabled(closed), config.enterButtonEmoji),
    applyButtonEmoji(new ButtonBuilder().setCustomId(`${PREFIX}:leave`).setLabel(config.leaveButtonText).setStyle(ButtonStyle.Secondary).setDisabled(closed), config.leaveButtonEmoji),
    applyButtonEmoji(new ButtonBuilder().setCustomId(`${PREFIX}:close`).setLabel(config.closeButtonText).setStyle(ButtonStyle.Danger).setDisabled(closed), config.closeButtonEmoji)
  );
  return renderComponentsV2Panel({
    accentColor: color(config.embedColor),
    actions: [buttons],
    description: config.descriptionText,
    fields: [
      [
    `## HISTORICO - ESCALACAO #${config.scaleId}`,
    `**Status:** ${closed ? "Encerrada" : "Aberta"}`,
    "",
    `**PILOTO**${config.pilotText ? `\n${config.pilotText}` : ""}`,
    formatSlots(config.pilotIds, config.maxPilots, memberNames),
    "",
    `**ATIRADOR**${config.shooterText ? `\n${config.shooterText}` : ""}`,
    formatSlots(config.shooterIds, config.maxShooters, memberNames)
      ].join("\n")
    ],
    footerText: config.panelFooter,
    image: image ? { imageEnabled: true, imagePosition: image.position, imageUrl: image.url } : null,
    moduleId: MODULE_ID,
    title: config.titleText
  });
}

function configPanelPayload(config: FlightConfig) {
  const roleSelect = (id: string, placeholder: string) => new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder().setCustomId(`${CONFIG_PREFIX}:${id}`).setPlaceholder(placeholder).setMinValues(0).setMaxValues(25)
  );
  const channelSelect = (id: string, placeholder: string, types: ChannelType[]) => new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`${CONFIG_PREFIX}:${id}`).setPlaceholder(placeholder).setChannelTypes(types).setMinValues(0).setMaxValues(25)
  );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONFIG_PREFIX}:publish`).setLabel("Publicar painel").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CONFIG_PREFIX}:reset`).setLabel("Resetar escala").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${CONFIG_PREFIX}:test_log`).setLabel("Testar log").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${CONFIG_PREFIX}:texts`).setLabel("Editar textos").setStyle(ButtonStyle.Primary)
  );
  return [{
    type: 17,
    accent_color: color(config.embedColor),
    components: [
      { type: 10, content: `# North Police Department - DAF\n\n**Status:** ${config.enabled ? "Ativado" : "Desativado"}\n**Painel:** ${config.panelChannelId ? `<#${config.panelChannelId}>` : "nao configurado"}\n**Logs:** ${config.logChannelId ? `<#${config.logChannelId}>` : "nao configurado"}\n**Regra:** cada usuario ocupa apenas uma categoria por escalacao.` },
      roleSelect("daf_roles", "Selecionar cargos da DAF"),
      roleSelect("allowed_roles", "Selecionar cargos autorizados"),
      channelSelect("panel_channel", "Selecionar canal do painel", [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      channelSelect("log_channel", "Selecionar canal de logs", [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      channelSelect("category", "Selecionar categoria da DAF", [ChannelType.GuildCategory]),
      buttons
    ]
  }];
}

function textModal(config: FlightConfig) {
  return new ModalBuilder()
    .setCustomId(`${CONFIG_PREFIX}:texts`)
    .setTitle("Textos do painel DAF")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("titleText").setLabel("Titulo").setStyle(TextInputStyle.Short).setMaxLength(120).setRequired(true).setValue(config.titleText)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("descriptionText").setLabel("Descricao").setStyle(TextInputStyle.Paragraph).setMaxLength(1200).setRequired(false).setValue(config.descriptionText)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("panelFooter").setLabel("Rodape").setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false).setValue(config.panelFooter))
    );
}

async function showJoinCategorySelect(interaction: ButtonInteraction) {
  const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:join_category`)
      .setPlaceholder("Selecione Piloto ou Atirador")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        { label: "Piloto", value: "pilot", emoji: "✈️", description: "Entrar na escala como Piloto" },
        { label: "Atirador", value: "shooter", emoji: "🎯", description: "Entrar na escala como Atirador" }
      )
  );
  await editDeferred(interaction, {
    components: [{
      type: 17,
      components: [
        { type: 10, content: "## Entrar na Escalacao DAF\nSelecione em qual categoria voce vai entrar." },
        select
      ]
    }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

async function loadConfig(guildId: string, context: BotContext, required = false) {
  const botId = currentRuntimeBotId();
  if (!botId) return defaultConfig();
  const runtime = await context.api.getBotGuildConfig(botId, guildId);
  const raw = runtime.modules[MODULE_ID];
  if (required && !raw) throw new Error("Configuracao DAF nao encontrada para este servidor e bot.");
  return normalizeDafConfig(raw ?? {});
}

export function normalizeDafConfig(raw: Record<string, unknown>): FlightConfig {
  const fallback = defaultConfig();
  const dafRoleIds = ids(raw.dafRoleIds).length ? ids(raw.dafRoleIds) : [...ids(raw.pilotRoleIds), ...ids(raw.shooterRoleIds)];
  const panelChannelId = str(raw.panelChannelId) ?? ids(raw.panelChannelIds)[0] ?? null;
  const logChannelId = str(raw.logChannelId) ?? ids(raw.logChannelIds)[0] ?? null;
  const categoryId = str(raw.categoryId) ?? ids(raw.categoryIds)[0] ?? null;
  return {
    ...fallback,
    enabled: raw.enabled === true,
    panelChannelId,
    panelChannelIds: panelChannelId ? [panelChannelId] : [],
    panelMessageId: str(raw.panelMessageId),
    panelMessageChannelId: str(raw.panelMessageChannelId),
    logChannelId,
    logChannelIds: logChannelId ? [logChannelId] : [],
    categoryId,
    categoryIds: categoryId ? [categoryId] : [],
    allowedRoleIds: ids(raw.allowedRoleIds),
    dafRoleIds,
    pilotRoleIds: ids(raw.pilotRoleIds),
    shooterRoleIds: ids(raw.shooterRoleIds),
    closeRoleIds: ids(raw.closeRoleIds),
    adminRoleIds: ids(raw.adminRoleIds),
    titleText: str(raw.panelTitle) ?? str(raw.titleText) ?? fallback.titleText,
    descriptionText: normalizeLegacyDefaultText(str(raw.panelDescription) ?? str(raw.descriptionText), [
      "Use os botoes abaixo para abrir uma nova escalacao de voo.\nApos aberto, os membros assumem as posicoes de Piloto e Atirador.\n\nAo finalizar, clique em Fechar Escalacao para encerrar e registrar."
    ], fallback.descriptionText),
    panelFooter: str(raw.panelFooter) ?? fallback.panelFooter,
    panelImage: str(raw.panelImage),
    pilotText: str(raw.pilotText) ?? fallback.pilotText,
    shooterText: str(raw.shooterText) ?? fallback.shooterText,
    enterPilotButtonText: str(raw.enterPilotButtonText) ?? str(raw.enterButtonText) ?? "Entrar como Piloto",
    enterShooterButtonText: str(raw.enterShooterButtonText) ?? str(raw.enterButtonText) ?? "Entrar como Atirador",
    enterButtonText: normalizeLegacyDefaultText(str(raw.enterButtonText), ["Abrir Escalacao de Voo"], fallback.enterButtonText),
    leaveButtonText: str(raw.leaveButtonText) ?? fallback.leaveButtonText,
    enterButtonEmoji: str(raw.enterButtonEmoji) ?? fallback.enterButtonEmoji,
    leaveButtonEmoji: str(raw.leaveButtonEmoji) ?? fallback.leaveButtonEmoji,
    closeButtonEmoji: str(raw.closeButtonEmoji) ?? fallback.closeButtonEmoji,
    closeButtonText: normalizeLegacyDefaultText(str(raw.closeButtonText), ["Fechar escalacao", "Fechar Escalacao"], fallback.closeButtonText),
    embedColor: str(raw.embedColor) ?? fallback.embedColor,
    allowSameUserBothFunctions: raw.allowSameUserBothFunctions === true,
    allowReplaceOccupiedRole: raw.allowReplaceOccupiedRole !== false,
    maxPilots: clampInt(raw.maxPilots, 1, 5, fallback.maxPilots),
    maxShooters: clampInt(raw.maxShooters, 1, 5, fallback.maxShooters),
    scaleId: Math.max(1, Number(raw.scaleId) || 1),
    status: raw.status === "closed" ? "closed" : "open",
    openedBy: str(raw.openedBy) ?? str(raw.openedByUserId),
    openedAt: str(raw.openedAt),
    closedBy: str(raw.closedBy) ?? str(raw.closedByUserId),
    closedAt: str(raw.closedAt),
    pilotIds: ids(raw.pilotIds).slice(0, clampInt(raw.maxPilots, 1, 5, fallback.maxPilots)),
    shooterIds: ids(raw.shooterIds).slice(0, clampInt(raw.maxShooters, 1, 5, fallback.maxShooters))
  };
}

function defaultConfig(): FlightConfig {
  return {
    enabled: false,
    panelChannelId: null,
    panelChannelIds: [],
    panelMessageId: null,
    panelMessageChannelId: null,
    logChannelId: null,
    logChannelIds: [],
    categoryId: null,
    categoryIds: [],
    allowedRoleIds: [],
    dafRoleIds: [],
    pilotRoleIds: [],
    shooterRoleIds: [],
    closeRoleIds: [],
    adminRoleIds: [],
    titleText: "North Police Department - DAF",
    descriptionText: "Use Entrar na Escalacao para escolher Piloto ou Atirador.\nUse Sair da Escalacao para liberar apenas a sua vaga.\n\nO encerramento oficial deve ser feito por um responsavel autorizado.",
    panelFooter: "",
    panelImage: null,
    pilotText: "Responsavel pelo voo",
    shooterText: "Responsavel pela cobertura",
    enterPilotButtonText: "Entrar como Piloto",
    enterShooterButtonText: "Entrar como Atirador",
    enterButtonText: "Entrar na Escalacao",
    leaveButtonText: "Sair da Escalacao",
    enterButtonEmoji: "✈️",
    leaveButtonEmoji: "🚪",
    closeButtonEmoji: "🔒",
    closeButtonText: "Encerrar Escalacao",
    embedColor: "#3b82f6",
    allowSameUserBothFunctions: false,
    allowReplaceOccupiedRole: true,
    maxPilots: 1,
    maxShooters: 1,
    scaleId: 1,
    status: "open",
    openedBy: null,
    openedAt: null,
    closedBy: null,
    closedAt: null,
    pilotIds: [],
    shooterIds: []
  };
}

async function sendScaleLog(guild: Guild, config: FlightConfig, closedConfig: FlightConfig, isTest: boolean) {
  const logChannelId = config.logChannelId ?? config.logChannelIds[0] ?? null;
  if (!logChannelId) {
    console.warn("[police-flight] canal de logs nao configurado", { guildId: guild.id });
    return;
  }
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn("[police-flight] canal de logs invalido", { guildId: guild.id, logChannelId: config.logChannelId });
    return;
  }
  const openedAt = closedConfig.openedAt ? new Date(closedConfig.openedAt) : new Date();
  const closedAt = closedConfig.closedAt ? new Date(closedConfig.closedAt) : new Date();
  const memberNames = await loadMemberNames(guild, [
    ...closedConfig.pilotIds,
    ...closedConfig.shooterIds,
    closedConfig.openedBy,
    closedConfig.closedBy
  ]);
  const content = [
    "# North Police Department - DAF",
    "",
    `## HISTORICO - ESCALACAO #${closedConfig.scaleId}`,
    "",
    "**PILOTO**",
    formatSlots(closedConfig.pilotIds, closedConfig.maxPilots, memberNames),
    "",
    "**ATIRADOR**",
    formatSlots(closedConfig.shooterIds, closedConfig.maxShooters, memberNames),
    "",
    "**Aberto por**",
    formatSlot(closedConfig.openedBy, memberNames),
    "",
    "**Responsavel pelo encerramento**",
    formatSlot(closedConfig.closedBy, memberNames),
    "",
    "**Horario de inicio**",
    formatLongDate(openedAt),
    "",
    "**Horario de encerramento**",
    formatLongDate(closedAt),
    "",
    `NPD - Escalacao #${closedConfig.scaleId} - Registro ${isTest ? "de teste" : "automatico"} - ${formatFooterDate(closedAt)}`
  ].join("\n");
  await channel.send({
    allowedMentions: { parse: [] },
    components: [{ type: 17, accent_color: color(config.embedColor), components: [{ type: 10, content }] }],
    flags: MessageFlags.IsComponentsV2
  }).catch((error) => {
    console.warn("[police-flight] falha ao enviar log:", error instanceof Error ? error.message : error);
  });
}

async function sendParticipantLeaveLog(guild: Guild, config: FlightConfig, userId: string, role: FlightRole) {
  const logChannelId = config.logChannelId ?? config.logChannelIds[0] ?? null;
  if (!logChannelId) {
    console.warn("[police-flight] canal de logs nao configurado para saida", { guildId: guild.id, userId });
    return;
  }
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn("[police-flight] canal de logs invalido para saida", { guildId: guild.id, logChannelId, userId });
    return;
  }
  const memberNames = await loadMemberNames(guild, [userId]);
  const roleLabel = role === "pilot" ? "Piloto" : "Atirador";
  const now = new Date();
  const content = [
    "# North Police Department - DAF",
    "",
    `## SAIDA DA ESCALACAO #${config.scaleId}`,
    "",
    "**Membro**",
    formatSlot(userId, memberNames),
    "",
    "**Categoria**",
    roleLabel,
    "",
    "**Horario**",
    formatLongDate(now),
    "",
    `NPD - Escalacao #${config.scaleId} - Saida de ${roleLabel} - ${formatFooterDate(now)}`
  ].join("\n");
  await channel.send({
    allowedMentions: { parse: [] },
    components: [{ type: 17, accent_color: color(config.embedColor), components: [{ type: 10, content }] }],
    flags: MessageFlags.IsComponentsV2
  }).catch((error) => {
    console.warn("[police-flight] falha ao enviar log de saida:", error instanceof Error ? error.message : error);
  });
}

async function canManageConfig(interaction: Interaction, config: FlightConfig) {
  if (!interaction.guild || !interaction.member) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const member = await ensureGuildMember(interaction);
  const managerRoleIds = [...config.allowedRoleIds, ...config.adminRoleIds].filter(Boolean);
  return member && managerRoleIds.length ? hasAnyRole(member, managerRoleIds) : false;
}

async function ensureGuildMember(interaction: Interaction) {
  if (!interaction.guild) return null;
  const cached = interaction.guild.members.cache.get(interaction.user.id);
  if (cached) return cached;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

function allowedParticipantRoles(config: FlightConfig, role: FlightRole) {
  const roleSpecific = role === "pilot" ? config.pilotRoleIds : config.shooterRoleIds;
  return [...config.allowedRoleIds, ...config.dafRoleIds, ...roleSpecific, ...config.adminRoleIds];
}

function canCloseScale(member: { roles: { cache: Map<string, unknown> } }, config: FlightConfig) {
  const roleIds = [...config.adminRoleIds, ...config.closeRoleIds].filter(Boolean);
  return roleIds.length ? hasAnyRole(member, roleIds) : false;
}

function hasAnyRole(member: { roles: { cache: Map<string, unknown> } }, roleIds: string[]) {
  const unique = [...new Set(roleIds.filter(Boolean))];
  if (!unique.length) return true;
  return unique.some((id) => member.roles.cache.has(id));
}

async function deferEphemeral(interaction: Interaction) {
  if (!interaction.isRepliable()) return;
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

async function editDeferred(interaction: Interaction, payload: string | { content?: string; components?: unknown[]; flags?: number }) {
  if (!interaction.isRepliable()) return;
  const replyPayload = typeof payload === "string" ? { content: payload, components: [] } : payload;
  if (interaction.deferred || interaction.replied) await interaction.editReply(replyPayload as never).catch(() => undefined);
  else await safeReply(interaction, payload);
}

async function loadDafPanelImage(guildId: string, context: BotContext, legacyImage: string | null) {
  let candidate = legacyImage;
  let position: PanelVisualPosition = "top";
  try {
    const settings = await context.api.getPanelVisualSettings(guildId, MODULE_ID);
    candidate = settings.imageEnabled ? settings.imageUrl : null;
    position = settings.imagePosition;
  } catch (error) {
    console.warn("[police-flight] configuracao de imagem DAF indisponivel; usando imagem legada", {
      error: discordErrorMessage(error),
      guildId
    });
  }
  const url = resolvePanelImageUrl(candidate);
  if (!url) return { position, url: null };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocolo invalido");
    return { position, url: parsed.toString() };
  } catch (error) {
    console.warn("[police-flight] imagem DAF invalida; painel sera publicado sem imagem", {
      error: discordErrorMessage(error),
      guildId,
      imageUrl: candidate
    });
    return { position, url: null };
  }
}

async function fetchDafPanelMessage(client: Client, channelId: string, messageId: string) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

function logDafPublishError(input: {
  botId: string;
  channelId: string | null;
  channelName?: string;
  error: unknown;
  guildId: string;
  permissions?: Record<string, boolean>;
  source: "dashboard" | "command" | "automatic";
}) {
  console.error("[police-flight] erro completo ao publicar painel DAF", {
    botId: input.botId,
    channelId: input.channelId,
    channelName: input.channelName ?? null,
    error: input.error instanceof Error ? input.error.stack ?? input.error.message : String(input.error),
    guildId: input.guildId,
    permissions: input.permissions ?? null,
    source: input.source
  });
}

function discordErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { code?: string | number; message?: string; rawError?: unknown };
  return [value.message ?? "Erro desconhecido", value.code ? `(codigo ${value.code})` : "", value.rawError ? JSON.stringify(value.rawError) : ""]
    .filter(Boolean)
    .join(" ");
}

function isInvalidImageError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string | number; message?: string; rawError?: unknown };
  const details = `${value.message ?? ""} ${value.rawError ? JSON.stringify(value.rawError) : ""}`;
  return String(value.code ?? "") === "50035" && /image|media|url/i.test(details);
}

async function safeReply(interaction: Interaction, payload: string | { content?: string; components?: unknown[]; flags?: number }) {
  if (!interaction.isRepliable()) return;
  const replyPayload = typeof payload === "string" ? { content: payload, flags: MessageFlags.Ephemeral } : payload;
  if (interaction.replied || interaction.deferred) await interaction.followUp(replyPayload as never).catch(() => undefined);
  else await interaction.reply(replyPayload as never).catch(() => undefined);
}

async function loadMemberNames(guild: Guild, userIds: Array<string | null | undefined>) {
  const uniqueIds = [...new Set(userIds.filter((id): id is string => typeof id === "string" && /^\d{5,32}$/.test(id)))];
  const names = new Map<string, string>();
  await Promise.all(uniqueIds.map(async (userId) => {
    const cached = guild.members.cache.get(userId);
    const member = cached ?? await guild.members.fetch(userId).catch(() => null);
    const displayName = member?.displayName?.trim()
      || member?.user.globalName?.trim()
      || member?.user.username?.trim()
      || userId;
    names.set(userId, displayName);
  }));
  return names;
}

function formatSlot(userId: string | null | undefined, memberNames?: Map<string, string>) {
  if (!userId) return "❌ Não preenchido";
  return memberNames?.get(userId) ?? userId;
}

function formatSlots(userIds: string[], maxSlots: number, memberNames?: Map<string, string>) {
  const slots = Array.from({ length: Math.max(1, maxSlots) }, (_, index) => userIds[index] ?? null);
  return slots.map((userId, index) => slots.length > 1 ? `${index + 1}. ${formatSlot(userId, memberNames)}` : formatSlot(userId, memberNames)).join("\n");
}

function applyButtonEmoji(button: ButtonBuilder, emoji: string) {
  const normalized = emoji.trim();
  if (!normalized) return button;
  try {
    return button.setEmoji(normalized);
  } catch {
    return button;
  }
}

function parseFlightRole(value: string): FlightRole | null {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (["piloto", "pilot"].includes(normalized)) return "pilot";
  if (["atirador", "shooter", "gunner"].includes(normalized)) return "shooter";
  return null;
}

function formatLongDate(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);
}

function formatFooterDate(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);
}

function str(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function ids(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function uniqueIds(value: string[]) { return [...new Set(value.filter((item) => /^\d{5,32}$/.test(item)))]; }
function normalizeLegacyDefaultText(value: string | null, legacyDefaults: string[], fallback: string) {
  if (!value) return fallback;
  const normalizedValue = normalizeTextForComparison(value);
  return legacyDefaults.some((legacy) => normalizeTextForComparison(legacy) === normalizedValue) ? fallback : value;
}
function normalizeTextForComparison(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function color(value: string) { const hex = value.replace("#", ""); return /^[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex, 16) : 0x3b82f6; }
