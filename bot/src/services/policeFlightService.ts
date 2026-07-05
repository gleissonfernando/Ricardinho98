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
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction
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
  enterPilotButtonText: string;
  enterShooterButtonText: string;
  closeButtonText: string;
  embedColor: string;
  allowSameUserBothFunctions: boolean;
  allowReplaceOccupiedRole: boolean;
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

  if (interaction.isButton() && action === "pilot") {
    await joinRole(interaction, context, config, "pilot");
    return true;
  }
  if (interaction.isButton() && action === "shooter") {
    await joinRole(interaction, context, config, "shooter");
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
  if (interaction.isButton() && action === "toggle_same_user") {
    await deferEphemeral(interaction);
    await context.api.updatePoliceFlightState(interaction.guild.id, {
      allowSameUserBothFunctions: !config.allowSameUserBothFunctions
    });
    await editDeferred(interaction, `Modo atualizado: ${!config.allowSameUserBothFunctions ? "permite" : "bloqueia"} mesma pessoa nas duas funcoes.`);
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
  await context.api.updatePoliceFlightState(interaction.guildId!, patch);
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

  if (!config.openedAt || config.status === "closed") {
    const saved = await context.api.updatePoliceFlightState(guild.id, {
      status: "open",
      openedBy: openedByUserId,
      openedAt: new Date().toISOString(),
      closedBy: null,
      closedAt: null,
      pilotIds: [],
      shooterIds: [],
      scaleId: config.status === "closed" ? config.scaleId + 1 : config.scaleId
    });
    config = normalizeDafConfig(saved.config);
  }

  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  const previousMessage = config.panelMessageId && config.panelMessageChannelId && config.panelMessageChannelId !== panelChannelId
    ? await fetchDafPanelMessage(client, config.panelMessageChannelId, config.panelMessageId)
    : null;
  const sendOrEdit = async (imageUrl: string | null) => {
    const payload = panelPayload(config, imageUrl ? { position: image.position, url: imageUrl } : null);
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

async function joinRole(interaction: ButtonInteraction, context: BotContext, config: FlightConfig, role: FlightRole) {
  await deferEphemeral(interaction);
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

  if (!config.openedAt || config.status === "closed") {
    config.status = "open";
    config.openedBy = interaction.user.id;
    config.openedAt = new Date().toISOString();
    config.closedBy = null;
    config.closedAt = null;
  }

  if (!config.allowSameUserBothFunctions) {
    if (role === "pilot") config.shooterIds = config.shooterIds.filter((id) => id !== interaction.user.id);
    else config.pilotIds = config.pilotIds.filter((id) => id !== interaction.user.id);
  }

  const key = role === "pilot" ? "pilotIds" : "shooterIds";
  if (!config.allowReplaceOccupiedRole && config[key].length && !config[key].includes(interaction.user.id)) {
    await editDeferred(interaction, `A vaga de ${role === "pilot" ? "Piloto" : "Atirador"} ja esta preenchida.`);
    return;
  }
  config[key] = [interaction.user.id];

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

async function closeScale(interaction: ButtonInteraction, context: BotContext, config: FlightConfig) {
  await deferEphemeral(interaction);
  const member = await ensureGuildMember(interaction);
  if (!member) {
    await editDeferred(interaction, "Nao foi possivel localizar seu membro no servidor.");
    return;
  }
  if (!hasAnyRole(member, [...config.allowedRoleIds, ...config.adminRoleIds, ...config.closeRoleIds, ...config.dafRoleIds])) {
    await editDeferred(interaction, "Voce nao possui permissao para participar da escalacao da DAF.");
    return;
  }

  const wasInScale = config.pilotIds.includes(interaction.user.id) || config.shooterIds.includes(interaction.user.id);
  if (!wasInScale && !hasAnyRole(member, [...config.adminRoleIds, ...config.closeRoleIds, ...config.allowedRoleIds])) {
    await editDeferred(interaction, "Voce nao esta escalado em nenhuma funcao.");
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
  await sendScaleLog(interaction.guild!, config, normalizeDafConfig(savedClosed.config), false);

  const nextScaleId = Math.max(1, finalConfig.scaleId + 1);
  const savedOpen = await context.api.updatePoliceFlightState(interaction.guildId!, {
    status: "open",
    openedBy: interaction.user.id,
    openedAt: new Date().toISOString(),
    closedBy: null,
    closedAt: null,
    pilotIds: [],
    shooterIds: [],
    scaleId: nextScaleId
  });
  await refreshPanel(interaction.guild!, context, normalizeDafConfig(savedOpen.config));
  await editDeferred(interaction, "Escalacao fechada e registrada.");
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
  if (message) await message.edit(panelPayload(config, image.url ? { position: image.position, url: image.url } : null)).catch((error) => {
    console.warn("[police-flight] falha ao editar painel:", error instanceof Error ? error.message : error);
  });
}

function panelPayload(config: FlightConfig, image: { position: PanelVisualPosition; url: string } | null) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:pilot`).setLabel(config.enterPilotButtonText).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:shooter`).setLabel(config.enterShooterButtonText).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}:close`).setLabel(config.closeButtonText).setStyle(ButtonStyle.Danger)
  );
  return renderComponentsV2Panel({
    accentColor: color(config.embedColor),
    actions: [buttons],
    description: config.descriptionText,
    fields: [
      [
    `## HISTORICO - ESCALACAO #${config.scaleId}`,
    "",
    "**PILOTO**",
    formatSlot(config.pilotIds[0]),
    "",
    "**ATIRADOR**",
    formatSlot(config.shooterIds[0])
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
    new ButtonBuilder().setCustomId(`${CONFIG_PREFIX}:toggle_same_user`).setLabel("Alternar modo").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${CONFIG_PREFIX}:texts`).setLabel("Editar textos").setStyle(ButtonStyle.Primary)
  );
  return [{
    type: 17,
    accent_color: color(config.embedColor),
    components: [
      { type: 10, content: `# North Police Department - DAF\n\n**Status:** ${config.enabled ? "Ativado" : "Desativado"}\n**Painel:** ${config.panelChannelId ? `<#${config.panelChannelId}>` : "nao configurado"}\n**Logs:** ${config.logChannelId ? `<#${config.logChannelId}>` : "nao configurado"}\n**Modo:** ${config.allowSameUserBothFunctions ? "permite mesma pessoa nas duas funcoes" : "move usuario ao trocar de funcao"}` },
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
    descriptionText: str(raw.panelDescription) ?? str(raw.descriptionText) ?? fallback.descriptionText,
    panelFooter: str(raw.panelFooter) ?? fallback.panelFooter,
    panelImage: str(raw.panelImage),
    enterPilotButtonText: str(raw.enterPilotButtonText) ?? "Entrar como Piloto",
    enterShooterButtonText: str(raw.enterShooterButtonText) ?? "Entrar como Atirador",
    closeButtonText: str(raw.closeButtonText) ?? fallback.closeButtonText,
    embedColor: str(raw.embedColor) ?? fallback.embedColor,
    allowSameUserBothFunctions: raw.allowSameUserBothFunctions === true,
    allowReplaceOccupiedRole: raw.allowReplaceOccupiedRole !== false,
    scaleId: Math.max(1, Number(raw.scaleId) || 1),
    status: raw.status === "closed" ? "closed" : "open",
    openedBy: str(raw.openedBy) ?? str(raw.openedByUserId),
    openedAt: str(raw.openedAt),
    closedBy: str(raw.closedBy) ?? str(raw.closedByUserId),
    closedAt: str(raw.closedAt),
    pilotIds: ids(raw.pilotIds).slice(0, 1),
    shooterIds: ids(raw.shooterIds).slice(0, 1)
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
    descriptionText: "",
    panelFooter: "",
    panelImage: null,
    enterPilotButtonText: "Entrar como Piloto",
    enterShooterButtonText: "Entrar como Atirador",
    closeButtonText: "Fechar escalacao",
    embedColor: "#3b82f6",
    allowSameUserBothFunctions: false,
    allowReplaceOccupiedRole: true,
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
  const content = [
    "# North Police Department - DAF",
    "",
    `## HISTORICO - ESCALACAO #${closedConfig.scaleId}`,
    "",
    "**PILOTO**",
    formatSlot(closedConfig.pilotIds[0]),
    "",
    "**ATIRADOR**",
    formatSlot(closedConfig.shooterIds[0]),
    "",
    "**Aberto por**",
    formatSlot(closedConfig.openedBy),
    "",
    "**Fechado por**",
    formatSlot(closedConfig.closedBy),
    "",
    "**Periodo**",
    `${formatLongDate(openedAt)} -> ${formatShortTime(closedAt)}`,
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

async function canManageConfig(interaction: Interaction, config: FlightConfig) {
  if (!interaction.guild || !interaction.member) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const member = await ensureGuildMember(interaction);
  return member ? hasAnyRole(member, [...config.allowedRoleIds, ...config.adminRoleIds]) : false;
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

async function editDeferred(interaction: Interaction, content: string) {
  if (!interaction.isRepliable()) return;
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [] }).catch(() => undefined);
  else await safeReply(interaction, content);
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

function formatSlot(userId: string | null | undefined) {
  return userId ? `<@${userId}> | ${userId}` : "❌ Não preenchido";
}

function formatLongDate(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);
}

function formatShortTime(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);
}

function formatFooterDate(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);
}

function str(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function ids(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function color(value: string) { const hex = value.replace("#", ""); return /^[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex, 16) : 0x3b82f6; }
