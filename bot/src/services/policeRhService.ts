import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";
import { renderComponentsV2Panel, type PanelVisualConfig, type PanelVisualPosition } from "./panelVisualRenderer";
import { sendPoliceLog } from "./policeLogService";

const MODULE_ID = "police-rh";
const PREFIX = "police_rh";
const DEFAULT_PANEL_IMAGE_URL = "/rh/rh-default-banner.png";
const ABSENCE_RECONCILE_INTERVAL_MS = 60_000;

type PoliceRhConfig = {
  enabled: boolean;
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelTitle: string;
  panelDescription: string;
  panelColor: string;
  panelBannerUrl: string;
  panelImageRemoved: boolean;
  panelImageUrl: string;
  panelImagePosition: PanelVisualPosition;
  panelFooterText: string;
  panelFooterImageUrl: string;
  absenceEnabled: boolean;
  absenceCategoryId: string | null;
  absencePanelChannelId: string | null;
  absenceLogChannelId: string | null;
  absenceRoleId: string | null;
  absenceApproverRoleIds: string[];
  absenceBannerUrl: string;
  absenceDmApprovedMessage: string;
  absenceDmRejectedMessage: string;
  absenceDmFinishedMessage: string;
  pendingAbsenceRemovals: PoliceRhPendingAbsenceRemoval[];
  absenceFooterText: string;
  absenceFooterImageUrl: string;
  absenceImagePosition: PanelVisualPosition;
  absenceImageUrl: string;
  adornoEnabled: boolean;
  adornoPanelChannelId: string | null;
  adornoCategoryId: string | null;
  adornoLogChannelId: string | null;
  adornoApproverRoleIds: string[];
  adornoResponsibleRoleIds: string[];
  adornoBannerUrl: string;
  adornoDmApprovedMessage: string;
  adornoDmRejectedMessage: string;
  adornoFooterImageUrl: string;
  adornoImagePosition: PanelVisualPosition;
  adornoImageUrl: string;
  adornoReviewMode: "panel" | "channel";
  adornoTitle: string;
  adornoDescription: string;
  adornoFooterText: string;
  rhLogChannelId: string | null;
};

type PoliceRhPendingAbsenceRemoval = {
  absenceRoleId: string;
  approvedAt: string;
  approvedBy: string | null;
  returnDate: string;
  returnDateKey: string;
  userId: string;
};

let policeRhServiceStarted = false;
let absenceReconcileRunning = false;
const absenceReconcileFailureLogAt = new Map<string, number>();

export function startPoliceRhService(client: Client<true>, context: BotContext) {
  if (policeRhServiceStarted) return;
  policeRhServiceStarted = true;

  context.socket.onPoliceRhPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;
    void publishPoliceRhPanel(guild, context, payload.action === "publish").catch((error) => {
      console.warn("[police-rh] falha ao publicar painel:", error instanceof Error ? error.message : error);
    });
  });

  void reconcilePoliceRhAbsenceRoles(client, context);
  const interval = setInterval(() => {
    void reconcilePoliceRhAbsenceRoles(client, context);
  }, ABSENCE_RECONCILE_INTERVAL_MS);
  interval.unref();
}

export async function showPoliceRhConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) && interaction.guild.ownerId !== interaction.user.id) {
    await interaction.reply({ content: "Voce precisa ser administrador para configurar o RH.", ephemeral: true });
    return;
  }
  const botId = currentRuntimeBotId();
  if (!botId) {
    await interaction.reply({ content: "Bot runtime nao identificado para sincronizar com a dashboard.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const patch: Record<string, unknown> = {};
  const panelChannel = interaction.options.getChannel("canal_painel", false, [ChannelType.GuildText]);
  const absenceChannel = interaction.options.getChannel("canal_ausencia", false, [ChannelType.GuildText]);
  const adornmentChannel = interaction.options.getChannel("canal_adorno", false, [ChannelType.GuildText]);
  const rhLogChannel = interaction.options.getChannel("logs_rh", false, [ChannelType.GuildText]);
  const absenceLogChannel = interaction.options.getChannel("logs_ausencia", false, [ChannelType.GuildText]);
  const adornmentLogChannel = interaction.options.getChannel("logs_adorno", false, [ChannelType.GuildText]);
  const absenceRole = interaction.options.getRole("cargo_ausencia", false);
  const approverRole = interaction.options.getRole("cargo_aprovador", false);
  const enabled = interaction.options.getBoolean("ativo");
  const publish = interaction.options.getBoolean("publicar_painel") ?? false;

  if (panelChannel) Object.assign(patch, { panelChannelId: panelChannel.id, rhPanelChannelId: panelChannel.id });
  if (absenceChannel) patch.absencePanelChannelId = absenceChannel.id;
  if (adornmentChannel) patch.adornoPanelChannelId = adornmentChannel.id;
  if (rhLogChannel) patch.rhLogChannelId = rhLogChannel.id;
  if (absenceLogChannel) patch.absenceLogChannelId = absenceLogChannel.id;
  if (adornmentLogChannel) patch.adornoLogChannelId = adornmentLogChannel.id;
  if (absenceRole) patch.absenceRoleId = absenceRole.id;
  if (enabled !== null) patch.enabled = enabled;

  if (approverRole) {
    const current = await context.api.getBotGuildConfig(botId, interaction.guildId);
    const currentConfig = current.modules[MODULE_ID] ?? {};
    const currentRoles = Array.isArray(currentConfig.absenceApproverRoleIds)
      ? currentConfig.absenceApproverRoleIds.filter((item): item is string => typeof item === "string")
      : [];
    patch.absenceApproverRoleIds = [...new Set([...currentRoles, approverRole.id])];
  }

  const saved = Object.keys(patch).length
    ? await context.api.savePoliceRhRuntimeConfig(interaction.guildId, patch)
    : { config: (await context.api.getBotGuildConfig(botId, interaction.guildId)).modules[MODULE_ID] ?? {} };

  if (publish) {
    await context.api.requestPoliceRhPanelPublish(interaction.guildId).catch(() => null);
  }

  const config = await loadConfig(interaction.guildId, context);
  await interaction.editReply([
    "Configuração do RH policial sincronizada com a dashboard.",
    "",
    `Status: ${config?.enabled ? "ativo" : "inativo"}`,
    `Painel principal: ${config?.panelChannelId ? `<#${config.panelChannelId}>` : "não configurado"}`,
    `Solicitações de ausência: ${config?.absencePanelChannelId ? `<#${config.absencePanelChannelId}>` : "não configurado"}`,
    `Solicitações de adorno: ${config?.adornoPanelChannelId ? `<#${config.adornoPanelChannelId}>` : "não configurado"}`,
    `Logs RH: ${config?.rhLogChannelId ? `<#${config.rhLogChannelId}>` : "não configurado"}`,
    `Logs ausência: ${config?.absenceLogChannelId ? `<#${config.absenceLogChannelId}>` : "não configurado"}`,
    `Logs adorno: ${config?.adornoLogChannelId ? `<#${config.adornoLogChannelId}>` : "não configurado"}`,
    `Cargo de ausência: ${config?.absenceRoleId ? `<@&${config.absenceRoleId}>` : "não configurado"}`,
    `Aprovadores: ${config?.absenceApproverRoleIds.length ? config.absenceApproverRoleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "não configurado"}`,
    "",
    publish ? "Publicação do painel solicitada." : "Use publicar_painel:true para publicar/atualizar o painel."
  ].join("\n"));
  void saved;
}

export async function handlePoliceRhInteraction(interaction: Interaction, context: BotContext) {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return false;
  if (!interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guild || !isBotModuleEnabled(MODULE_ID)) return true;

  const config = await loadConfig(interaction.guild.id, context);
  if (!config?.enabled) {
    if (interaction.isRepliable()) await interaction.reply({ content: "❌ O sistema RH está desativado.", ephemeral: true }).catch(() => null);
    return true;
  }

  const [, action] = interaction.customId.split(":");
  if (interaction.isButton() && action === "absence") {
    await interaction.showModal(absenceModal());
    return true;
  }
  if (interaction.isButton() && action === "adorno") {
    if (!config.adornoPanelChannelId) {
      await interaction.reply({ content: "O canal do sistema de adorno ainda não foi configurado.", ephemeral: true });
      return true;
    }
    await interaction.showModal(adornoModal());
    return true;
  }
  if (interaction.isModalSubmit() && action === "absence_submit") {
    await createAbsenceRequestChannel(interaction, context, config);
    return true;
  }
  if (interaction.isModalSubmit() && action === "adorno_submit") {
    await publishAdornmentRequest(interaction, context, config);
    return true;
  }
  if (interaction.isButton() && (action === "adorno_approve" || action === "adorno_reject")) {
    await handleAdornmentReviewAction(interaction, context, config, action === "adorno_approve" ? "approved" : "rejected");
    return true;
  }
  if (interaction.isButton() && ["approve", "reject", "close"].includes(action ?? "")) {
    await handleReviewAction(interaction, context, config, action as "approve" | "reject" | "close");
    return true;
  }
  return true;
}

async function publishPoliceRhPanel(guild: Guild, context: BotContext, allowCreate: boolean) {
  const config = await loadConfig(guild.id, context);
  if (!config?.enabled) throw new Error("❌ Ative o RH - Ausências e Adornos antes de publicar.");
  if (!config.panelChannelId) throw new Error("📢 Configure o canal do painel antes de publicar.");
  const channel = await guild.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel || !("messages" in channel) || !("send" in channel)) throw new Error("❌ O canal configurado não aceita mensagens.");
  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  if (message) {
    await message.edit(mainPanelPayload(config));
  } else if (allowCreate) {
    message = await channel.send(mainPanelPayload(config));
  }
  if (message && message.id !== config.panelMessageId) await context.api.updatePoliceRhPanelState(guild.id, message.id).catch(() => null);
}

function mainPanelPayload(config: PoliceRhConfig) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:absence`).setEmoji("📝").setLabel("Solicitar Ausência").setStyle(ButtonStyle.Primary).setDisabled(!config.absenceEnabled),
    new ButtonBuilder().setCustomId(`${PREFIX}:adorno`).setEmoji("🎖️").setLabel("Solicitar Adorno").setStyle(ButtonStyle.Success).setDisabled(!config.adornoEnabled)
  );
  return renderComponentsV2Panel({
    accentColor: colorToInt(config.panelColor),
    actions: [buttons],
    description: config.panelDescription,
    footerIcon: visual(config.panelFooterImageUrl, "footer"),
    footerText: config.panelFooterText,
    image: visual(config.panelImageUrl || config.panelBannerUrl, config.panelImagePosition),
    moduleId: MODULE_ID,
    title: withEmoji(config.panelTitle, "🏢")
  });
}

function absenceModal() {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}:absence_submit`)
    .setTitle("📝 Solicitar Ausência")
    .addComponents(
      inputRow("startDate", "📅 Data de início da ausência", "Ex: 05/07/2026"),
      inputRow("returnDate", "📅 Data de retorno", "Ex: 10/07/2026"),
      inputRow("reason", "📝 Motivo", "Explique o motivo da ausência", TextInputStyle.Paragraph)
    );
}

function adornoModal() {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}:adorno_submit`)
    .setTitle("🎖️ Solicitar Adorno")
    .addComponents(
      inputRow("adornmentNumber", "Número do Adorno", "Ex: 61"),
      inputRow("imageUrl", "Link do comprovante do adorno", "https://...")
    );
}

function inputRow(id: string, label: string, placeholder: string, style: TextInputStyle = TextInputStyle.Short) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setRequired(true).setStyle(style).setMaxLength(style === TextInputStyle.Paragraph ? 1000 : 200)
  );
}

async function createAbsenceRequestChannel(interaction: ModalSubmitInteraction, context: BotContext, config: PoliceRhConfig) {
  const approverRoleIds = config.absenceApproverRoleIds;
  const channelId = config.absencePanelChannelId;
  if (!channelId) {
    await interaction.reply({ content: "📢 Canal de solicitações de ausência não configurado.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild!;
  const requester = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (config.absenceRoleId && requester?.roles.cache.has(config.absenceRoleId)) {
    await interaction.editReply("❌ Você já está em ausência. Só é possível pedir novamente quando a ausência acabar ou quando o cargo de ausência for removido.");
    return;
  }
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    await interaction.editReply("❌ Canal de solicitações de ausência inválido ou removido.");
    return;
  }
  const returnDate = interaction.fields.getTextInputValue("returnDate");
  const fields = [
    `**👤 Solicitante:** <@${interaction.user.id}>`,
    `**📅 Início:** ${interaction.fields.getTextInputValue("startDate")}`,
    `**📅 Retorno:** ${interaction.fields.getTextInputValue("returnDate")}`,
    `**📝 Motivo:** ${interaction.fields.getTextInputValue("reason")}`,
    "**⏳ Status:** Aguardando análise"
  ];
  await channel.send({
    allowedMentions: { roles: approverRoleIds, users: [interaction.user.id] },
    content: [`<@${interaction.user.id}>`, ...approverRoleIds.map((roleId) => `<@&${roleId}>`)].join(" ")
  }).catch(() => null);
  await channel.send(absenceRequestPanelPayload(config, fields, interaction.user.id, returnDate));
  await writeLog(context, guild.id, interaction.user.id, "police-rh.absence.created", "📋 Solicitação de ausência criada.", { channelId: channel.id, fields });
  await interaction.editReply(`✅ Solicitação enviada para <#${channel.id}>.`);
}

async function publishAdornmentRequest(interaction: ModalSubmitInteraction, context: BotContext, config: PoliceRhConfig) {
  if (!config.adornoPanelChannelId) {
    await interaction.reply({ content: "O canal do sistema de adorno ainda não foi configurado.", ephemeral: true });
    return;
  }
  const imageUrl = interaction.fields.getTextInputValue("imageUrl").trim();
  if (!validLinkUrl(imageUrl)) {
    await interaction.reply({ content: "Você precisa informar um link válido do adorno.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await interaction.guild!.channels.fetch(config.adornoPanelChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    await interaction.editReply("O canal do sistema de adorno ainda não foi configurado.");
    return;
  }
  const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
  const displayName = member?.displayName || interaction.user.username;
  const adornmentNumber = interaction.fields.getTextInputValue("adornmentNumber").trim();
  const panelInput = {
    adornmentNumber,
    displayName,
    imageUrl,
    requestedAt: new Date(),
    userId: interaction.user.id
  };
  const token = adornmentActionToken(interaction.user.id, adornmentNumber);
  if (config.adornoReviewMode === "channel") {
    const reviewChannel = await createAdornmentReviewChannel(interaction, config, panelInput);
    if (!reviewChannel) return;
    await reviewChannel.send(adornmentPanelPayload(config, panelInput, true, token, "pending")).catch(() => reviewChannel.send(adornmentPanelPayload(config, panelInput, false, token, "pending")));
    await interaction.editReply(`✅ Solicitação de adorno enviada para <#${reviewChannel.id}>.`);
  } else {
    await channel.send(adornmentPanelPayload(config, panelInput, true, token, "pending")).catch(() => channel.send(adornmentPanelPayload(config, panelInput, false, token, "pending")));
    await interaction.editReply("✅ Solicitação de adorno enviada.");
  }
  await writeLog(context, interaction.guild!.id, interaction.user.id, "police-rh.adorno.created", "🏅 Solicitação de adorno publicada.", {
    adornmentNumber,
    channelId: channel.id,
    imageUrl
  });
}

async function createAdornmentReviewChannel(interaction: ModalSubmitInteraction, config: PoliceRhConfig, input: { adornmentNumber: string; displayName: string; imageUrl: string; requestedAt: Date; userId: string }) {
  if (!config.adornoCategoryId) {
    await interaction.editReply("Configure a categoria dos canais de adorno antes de usar o modo por canal.");
    return null;
  }
  const category = await interaction.guild!.channels.fetch(config.adornoCategoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.editReply("A categoria dos canais de adorno nao foi encontrada.");
    return null;
  }
  const approverRoleIds = uniqueIds([...config.adornoApproverRoleIds, ...config.adornoResponsibleRoleIds]);
  if (!approverRoleIds.length) {
    await interaction.editReply("Configure ao menos um cargo aprovador/responsavel de adorno.");
    return null;
  }
  const me = interaction.guild!.members.me ?? await interaction.guild!.members.fetchMe().catch(() => null);
  return interaction.guild!.channels.create({
    name: safeChannelName(`adorno-${input.displayName}-${input.adornmentNumber}`),
    parent: category.id,
    topic: `${PREFIX}|adorno|${input.userId}|${Date.now()}|${encodeURIComponent(input.adornmentNumber)}`.slice(0, 1024),
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: interaction.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: input.userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }] : []),
      ...approverRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }))
    ],
    reason: `Solicitacao de adorno criada por ${interaction.user.tag}`
  }).catch(async () => {
    await interaction.editReply("Nao foi possivel criar o canal privado do adorno.");
    return null;
  });
}

function adornmentPanelPayload(config: PoliceRhConfig, input: { adornmentNumber: string; displayName: string; imageUrl: string; requestedAt: Date; userId: string }, includePreview: boolean, token: string, status: "pending" | "approved" | "rejected") {
  const logoUrl = config.adornoImageUrl || config.adornoBannerUrl || config.adornoFooterImageUrl;
  const header = `**${config.adornoTitle || "North Police Department"}**`;
  const locked = status !== "pending";
  const statusLabel = status === "approved" ? "✅ Aprovado" : status === "rejected" ? "❌ Recusado" : "⏳ Pendente";
  const fields = [
    `**Nome**\n${input.displayName}`,
    `**ID**\n${input.userId}`,
    `**Número do Adorno**\n${input.adornmentNumber}`,
    `**Solicitante**\n<@${input.userId}>`,
    `**Status**\n${statusLabel}`,
    `**Link do comprovante do adorno**\n[Clique aqui para abrir](${input.imageUrl})`
  ];
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:adorno_approve:${token}`).setEmoji("✅").setLabel("Aprovar Adorno").setStyle(ButtonStyle.Success).setDisabled(locked),
    new ButtonBuilder().setCustomId(`${PREFIX}:adorno_reject:${token}`).setEmoji("❌").setLabel("Recusar Adorno").setStyle(ButtonStyle.Danger).setDisabled(locked)
  );
  const components: any[] = [
    logoUrl
      ? { type: 9, components: [{ type: 10, content: `${header}\n# 🏅 Solicitação de Adorno` }], accessory: { type: 11, media: { url: logoUrl }, description: "Logo" } }
      : { type: 10, content: `${header}\n# 🏅 Solicitação de Adorno` },
    ...fields.map((content) => ({ type: 10, content })),
    ...(includePreview ? [{ type: 12, items: [{ media: { url: input.imageUrl }, description: `Adorno ${input.adornmentNumber}` }] }] : []),
    { type: 14, divider: true, spacing: 1 },
    { type: 10, content: `-# 🏅 ${config.adornoFooterText || "Solicitação enviada ao HCMD"} • ${formatAdornmentDate(input.requestedAt)}` },
    actions
  ];
  return {
    allowedMentions: { parse: [], users: [input.userId] },
    components: [{ type: 17, accent_color: 0x22c55e, components }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

async function handleAdornmentReviewAction(interaction: ButtonInteraction, context: BotContext, config: PoliceRhConfig, status: "approved" | "rejected") {
  if (!interaction.guild) return;
  const token = interaction.customId.split(":")[2] ?? "";
  const parsed = parseAdornmentActionToken(token);
  if (!parsed) {
    await interaction.reply({ content: "Solicitação de adorno inválida.", ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const approverRoleIds = uniqueIds([...config.adornoApproverRoleIds, ...config.adornoResponsibleRoleIds]);
  const allowed = Boolean(member?.permissions.has(PermissionFlagsBits.Administrator) || approverRoleIds.some((roleId) => member?.roles.cache.has(roleId)));
  if (!allowed) {
    await interaction.reply({ content: "Apenas aprovadores/responsaveis de adorno podem executar esta acao.", ephemeral: true });
    return;
  }
  const panelInput = {
    adornmentNumber: parsed.adornmentNumber,
    displayName: parsed.userId,
    imageUrl: "",
    requestedAt: new Date(),
    userId: parsed.userId
  };
  await interaction.update(adornmentPanelPayload(config, panelInput, false, token, status));
  const dmMessage = status === "approved" ? config.adornoDmApprovedMessage : config.adornoDmRejectedMessage;
  const user = await interaction.client.users.fetch(parsed.userId).catch(() => null);
  await user?.send(renderComponentsV2Panel({
    accentColor: status === "approved" ? 0x22c55e : 0xef4444,
    description: `${dmMessage}\n\n**Adorno:** ${parsed.adornmentNumber}\n**Responsavel:** <@${interaction.user.id}>`,
    image: visual(config.adornoImageUrl || config.adornoBannerUrl || config.adornoFooterImageUrl, config.adornoImagePosition === "none" ? "side" : config.adornoImagePosition),
    moduleId: MODULE_ID,
    title: status === "approved" ? "✅ Adorno aprovado" : "❌ Adorno recusado"
  })).catch(() => null);
  await writeLog(context, interaction.guild.id, interaction.user.id, `police-rh.adorno.${status}`, `🏅 Solicitação de adorno ${status === "approved" ? "aprovada" : "recusada"}.`, { adornmentNumber: parsed.adornmentNumber, requesterId: parsed.userId }).catch(() => null);
}

function absenceRequestPanelPayload(config: PoliceRhConfig, fields: string[], userId: string, returnDate: string | null, status = "⏳ Pendente") {
  const imageUrl = config.absenceImageUrl || config.absenceBannerUrl;
  const token = absenceActionToken(userId, returnDate);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:approve:${token}`).setEmoji("✅").setLabel("Aprovar Ausência").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:reject:${token}`).setEmoji("❌").setLabel("Recusar Ausência").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}:close:${token}`).setEmoji("🔒").setLabel("Fechar Solicitação").setStyle(ButtonStyle.Secondary)
  );
  return renderComponentsV2Panel({
    accentColor: 0xf59e0b,
    actions: [buttons],
    description: `📌 Status: **${status}**`,
    fields,
    footerIcon: visual(config.absenceFooterImageUrl, "footer"),
    image: visual(imageUrl, config.absenceImagePosition),
    moduleId: MODULE_ID,
    title: "📋 Solicitação de Ausência criada"
  });
}

function absenceReviewedPanel(config: PoliceRhConfig, status: string, token: string) {
  const imageUrl = config.absenceImageUrl || config.absenceBannerUrl;
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:approve:${token}`).setEmoji("✅").setLabel("Aprovar Ausência").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PREFIX}:reject:${token}`).setEmoji("❌").setLabel("Recusar Ausência").setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PREFIX}:close:${token}`).setEmoji("🔒").setLabel("Fechar Solicitação").setStyle(ButtonStyle.Secondary).setDisabled(true)
  );
  return renderComponentsV2Panel({
    accentColor: status.includes("✅") ? 0x22c55e : status.includes("❌") ? 0xef4444 : 0x71717a,
    actions: [buttons],
    description: status,
    fields: [],
    footerIcon: visual(config.absenceFooterImageUrl, "footer"),
    image: visual(imageUrl, config.absenceImagePosition),
    moduleId: MODULE_ID,
    title: "📋 Solicitação de Ausência"
  });
}

async function handleReviewAction(interaction: ButtonInteraction, context: BotContext, config: PoliceRhConfig, action: "approve" | "reject" | "close") {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({ content: "❌ Não consegui identificar o servidor ou canal desta solicitação.", ephemeral: true }).catch(() => null);
    return;
  }
  const token = interaction.customId.split(":")[2] ?? "";
  const topic = parseAbsenceActionToken(token);
  if (!topic) {
    await interaction.reply({ content: "❌ Esta solicitação de ausência está inválida ou expirada.", ephemeral: true }).catch(() => null);
    return;
  }
  const allowedRoles = config.absenceApproverRoleIds;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const allowed = Boolean(member?.permissions.has(PermissionFlagsBits.Administrator) || allowedRoles.some((roleId) => member?.roles.cache.has(roleId)));
  if (!allowed) {
    await interaction.reply({ content: "❌ Apenas cargos aprovadores configurados podem executar esta ação.", ephemeral: true });
    return;
  }
  const approved = action === "approve";
  const status = action === "close"
    ? "🔒 Solicitação fechada."
    : `${approved ? "✅" : "❌"} Solicitação ${approved ? "aprovada" : "recusada"}.`;
  await interaction.update(absenceReviewedPanel(config, status, token));

  if (action === "close") {
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-rh.closed", "🔒 Solicitação de ausência fechada.", { channelId: interaction.channel.id, requesterId: topic.userId, type: "absence" }).catch(() => null);
    return;
  }
  if (approved && config.absenceRoleId) {
    const requester = await interaction.guild.members.fetch(topic.userId).catch(() => null);
    await requester?.roles.add(config.absenceRoleId, `Ausência aprovada por ${interaction.user.tag}`).catch(() => null);
    await registerPendingAbsenceRemoval(interaction.guild.id, context, config, topic.userId, topic.returnDate, interaction.user.id);
    scheduleAbsenceRoleRemoval(interaction.guild, context, config, topic.userId, topic.returnDate);
  }
  const dmMessage = approved ? config.absenceDmApprovedMessage : config.absenceDmRejectedMessage;
  await sendAbsenceReviewDm(interaction, config, topic.userId, approved ? "approved" : "rejected", dmMessage, topic.returnDate);
  await writeLog(context, interaction.guild.id, interaction.user.id, `police-rh.absence.${approved ? "approved" : "rejected"}`, `${approved ? "✅" : "❌"} Solicitação de ausência ${approved ? "aprovada" : "recusada"}.`, { channelId: interaction.channel.id, requesterId: topic.userId }).catch(() => null);
}

async function loadConfig(guildId: string, context: BotContext): Promise<PoliceRhConfig | null> {
  const botId = currentRuntimeBotId();
  if (!botId) return null;
  const runtime = await context.api.getBotGuildConfig(botId, guildId);
  const raw = runtime.modules[MODULE_ID] ?? {};
  const panelImageRemoved = raw.panelImageRemoved === true;
  const [panelVisual, absenceVisual, adornoVisual] = await Promise.all([
    loadPanelVisual(context, guildId, "police-rh"),
    loadPanelVisual(context, guildId, "police-rh-absence"),
    loadPanelVisual(context, guildId, "police-rh-adorno")
  ]);
  return {
    enabled: raw.enabled === true,
    panelChannelId: readString(raw.panelChannelId) ?? readString(raw.rhPanelChannelId) ?? readString(raw.absencePanelChannelId) ?? readString(raw.adornoPanelChannelId),
    panelMessageId: readString(raw.panelMessageId),
    panelTitle: readString(raw.panelTitle) ?? "🏢 RH - Ausências e Adornos",
    panelDescription: readString(raw.panelDescription) ?? "📋 Selecione uma das opções abaixo para abrir sua solicitação.\nCada pedido será analisado pela equipe responsável antes de ser processado.",
    panelColor: readString(raw.panelColor) ?? "#7c3aed",
    panelBannerUrl: panelImageRemoved ? "" : readString(raw.panelBannerUrl) ?? "",
    panelImageRemoved,
    panelImageUrl: panelImageRemoved ? "" : (readString(raw.panelImageUrl) ?? panelVisual.imageUrl) || DEFAULT_PANEL_IMAGE_URL,
    panelImagePosition: panelImageRemoved ? "none" : readImagePosition(raw.panelImagePosition, panelVisual.imagePosition === "none" ? "top" : panelVisual.imagePosition),
    panelFooterText: readString(raw.panelFooterText) ?? "📌 RH - Sistema interno",
    panelFooterImageUrl: readString(raw.panelFooterImageUrl) ?? "",
    absenceEnabled: raw.absenceEnabled !== false,
    absenceCategoryId: readString(raw.absenceCategoryId),
    absencePanelChannelId: readString(raw.absencePanelChannelId),
    absenceLogChannelId: readString(raw.absenceLogChannelId),
    absenceRoleId: readString(raw.absenceRoleId),
    absenceApproverRoleIds: idList(raw.absenceApproverRoleIds),
    absenceBannerUrl: readString(raw.absenceBannerUrl) ?? "",
    absenceDmApprovedMessage: readString(raw.absenceDmApprovedMessage) ?? "✅ Sua solicitação de ausência foi aprovada.\n⏰ Quando chegar a data de retorno, seu cargo de ausência será removido automaticamente.",
    absenceDmRejectedMessage: readString(raw.absenceDmRejectedMessage) ?? "❌ Sua solicitação de ausência foi recusada.",
    absenceDmFinishedMessage: readString(raw.absenceDmFinishedMessage) ?? "⏰ Sua ausência acabou. Você pode voltar ao RP/trabalho.",
    pendingAbsenceRemovals: readPendingAbsenceRemovals(raw.pendingAbsenceRemovals),
    absenceFooterText: readString(raw.absenceFooterText) ?? "📝 Solicitação de ausência",
    absenceFooterImageUrl: readString(raw.absenceFooterImageUrl) ?? "",
    absenceImagePosition: readImagePosition(raw.absenceImagePosition, absenceVisual.imagePosition),
    absenceImageUrl: readString(raw.absenceImageUrl) ?? absenceVisual.imageUrl,
    adornoEnabled: raw.adornoEnabled !== false,
    adornoPanelChannelId: readString(raw.adornoPanelChannelId),
    adornoCategoryId: readString(raw.adornoCategoryId),
    adornoLogChannelId: readString(raw.adornoLogChannelId),
    adornoApproverRoleIds: idList(raw.adornoApproverRoleIds),
    adornoResponsibleRoleIds: idList(raw.adornoResponsibleRoleIds),
    adornoBannerUrl: readString(raw.adornoBannerUrl) ?? "",
    adornoDmApprovedMessage: readString(raw.adornoDmApprovedMessage) ?? "✅ Sua solicitação de adorno foi aprovada.",
    adornoDmRejectedMessage: readString(raw.adornoDmRejectedMessage) ?? "❌ Sua solicitação de adorno foi recusada.",
    adornoFooterImageUrl: readString(raw.adornoFooterImageUrl) ?? "",
    adornoImagePosition: readImagePosition(raw.adornoImagePosition, adornoVisual.imagePosition),
    adornoImageUrl: readString(raw.adornoImageUrl) ?? adornoVisual.imageUrl,
    adornoReviewMode: readString(raw.adornoReviewMode) === "channel" ? "channel" : "panel",
    adornoTitle: readString(raw.adornoTitle) ?? "North Police Department",
    adornoDescription: readString(raw.adornoDescription) ?? "",
    adornoFooterText: readString(raw.adornoFooterText) ?? "Solicitação enviada ao HCMD",
    rhLogChannelId: readString(raw.rhLogChannelId)
  };
}

async function sendAbsenceReviewDm(interaction: ButtonInteraction, config: PoliceRhConfig, userId: string, status: "approved" | "rejected", message: string, returnDate: string | null) {
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  if (!user) return;
  const approved = status === "approved";
  const title = approved ? "✅ Solicitação de Ausência Aprovada" : "❌ Solicitação de Ausência Recusada";
  const color = approved ? 0x22c55e : 0xef4444;
  await user.send(renderComponentsV2Panel({
    accentColor: color,
    description: [
      message,
      "",
      `**Status:** ${approved ? "Aprovada" : "Recusada"}`,
      `**Solicitante:** <@${userId}>`,
      returnDate ? `**Retorno previsto:** ${returnDate}` : null,
      `**Responsavel:** <@${interaction.user.id}>`,
      `**Atualizado em:** <t:${Math.floor(Date.now() / 1000)}:F>`
    ].filter(Boolean).join("\n"),
    footerIcon: visual(config.absenceFooterImageUrl, "footer"),
    footerText: config.absenceFooterText || "RH - Ausencias",
    image: visual(config.absenceImageUrl || config.absenceBannerUrl || config.absenceFooterImageUrl, config.absenceImagePosition === "none" ? "side" : config.absenceImagePosition),
    moduleId: MODULE_ID,
    title
  })).catch(() => null);
}

function parseTopic(topic: string) {
  const [prefix, type, userId, , encodedReturnDate] = topic.split("|");
  if (prefix !== PREFIX || (type !== "absence" && type !== "adorno") || !/^\d{5,32}$/.test(userId ?? "")) return null;
  return { returnDate: encodedReturnDate ? decodeURIComponent(encodedReturnDate) : null, type, userId: userId as string };
}

function absenceActionToken(userId: string, returnDate: string | null) {
  return `${userId}|${encodeURIComponent(returnDate ?? "")}`;
}

function parseAbsenceActionToken(value: string) {
  const [userId, encodedReturnDate] = value.split("|");
  if (!/^\d{5,32}$/.test(userId ?? "")) return null;
  return { returnDate: encodedReturnDate ? decodeURIComponent(encodedReturnDate) : null, userId: userId as string };
}

function adornmentActionToken(userId: string, adornmentNumber: string) {
  return `${userId}|${encodeURIComponent(adornmentNumber)}`;
}

function parseAdornmentActionToken(value: string) {
  const [userId, encodedAdornmentNumber] = value.split("|");
  if (!/^\d{5,32}$/.test(userId ?? "")) return null;
  return {
    adornmentNumber: encodedAdornmentNumber ? decodeURIComponent(encodedAdornmentNumber) : "",
    userId: userId as string
  };
}

function scheduleAbsenceRoleRemoval(guild: Guild, context: BotContext, config: PoliceRhConfig, userId: string, returnDate: string | null) {
  if (!config.absenceRoleId || !returnDate) return;
  const dueAt = parseReturnDate(returnDate);
  if (!dueAt) return;
  const delay = dueAt.getTime() - Date.now();
  if (delay <= 0 || delay > 2_147_000_000) return;
  setTimeout(() => {
    void guild.members.fetch(userId).then(async (member) => {
      await member.roles.remove(config.absenceRoleId!, "Retorno automatico de ausencia").catch(() => null);
      await member.send(renderComponentsV2Panel({
        accentColor: 0x22c55e,
        description: config.absenceDmFinishedMessage,
        moduleId: MODULE_ID,
        title: "⏰ Ausência finalizada"
      })).catch(() => null);
      await writeLog(context, guild.id, userId, "police-rh.absence.finished", "⏰ Cargo de ausência removido automaticamente na data de retorno.", { roleId: config.absenceRoleId, returnDate });
    }).catch(() => null);
  }, delay).unref?.();
}

async function registerPendingAbsenceRemoval(guildId: string, context: BotContext, config: PoliceRhConfig, userId: string, returnDate: string | null, approvedBy: string | null) {
  if (!config.absenceRoleId || !returnDate) return;
  const returnDateKey = parseReturnDateKey(returnDate);
  if (!returnDateKey) return;
  const latest = await loadConfig(guildId, context).catch(() => null);
  const current = latest?.pendingAbsenceRemovals ?? config.pendingAbsenceRemovals;
  const entry: PoliceRhPendingAbsenceRemoval = {
    absenceRoleId: config.absenceRoleId,
    approvedAt: new Date().toISOString(),
    approvedBy,
    returnDate,
    returnDateKey,
    userId
  };
  const next = [
    ...current.filter((item) => pendingAbsenceKey(item) !== pendingAbsenceKey(entry)),
    entry
  ].sort((left, right) => left.returnDateKey.localeCompare(right.returnDateKey)).slice(-500);
  await context.api.savePoliceRhRuntimeConfig(guildId, { pendingAbsenceRemovals: next }).catch((error) => {
    console.warn("[police-rh] falha ao salvar retorno pendente de ausencia:", error instanceof Error ? error.message : error);
  });
}

async function reconcilePoliceRhAbsenceRoles(client: Client<true>, context: BotContext) {
  if (absenceReconcileRunning || !isBotModuleEnabled(MODULE_ID)) return;
  absenceReconcileRunning = true;
  const today = currentDateKey();

  try {
    for (const guild of client.guilds.cache.values()) {
      const completed = new Set<string>();
      const config = await loadConfig(guild.id, context).catch((error) => {
        console.warn(`[police-rh] falha ao carregar config para reconciliar ausencias em ${guild.id}:`, error instanceof Error ? error.message : error);
        return null;
      });
      if (!config?.enabled || !config.pendingAbsenceRemovals.length) continue;

      for (const entry of config.pendingAbsenceRemovals) {
        if (entry.returnDateKey > today) continue;
        const result = await removePendingAbsenceRole(guild, entry);
        const key = pendingAbsenceKey(entry);

        if (result.done) {
          completed.add(key);
          await notifyFinishedAbsence(guild, context, config, entry).catch(() => null);
          await writeLog(context, guild.id, entry.userId, "police-rh.absence.finished", "⏰ Cargo de ausência removido automaticamente na data de retorno.", {
            returnDate: entry.returnDate,
            returnDateKey: entry.returnDateKey,
            roleId: entry.absenceRoleId
          });
        } else {
          logPendingAbsenceFailure(key, `[police-rh] falha ao remover cargo de ausencia em ${guild.id}/${entry.userId}: ${result.reason}`);
        }
      }

      if (completed.size) {
        const latest = await loadConfig(guild.id, context).catch(() => null);
        const next = (latest?.pendingAbsenceRemovals ?? config.pendingAbsenceRemovals)
          .filter((entry) => !completed.has(pendingAbsenceKey(entry)));
        await context.api.savePoliceRhRuntimeConfig(guild.id, { pendingAbsenceRemovals: next }).catch((error) => {
          console.warn("[police-rh] falha ao limpar retornos de ausencia concluidos:", error instanceof Error ? error.message : error);
        });
      }
    }
  } catch (error) {
    console.warn("[police-rh] falha no reconciliador de ausencias:", error instanceof Error ? error.message : error);
  } finally {
    absenceReconcileRunning = false;
  }
}

async function removePendingAbsenceRole(guild: Guild, entry: PoliceRhPendingAbsenceRemoval) {
  const role = await guild.roles.fetch(entry.absenceRoleId).catch(() => null);
  if (!role) return { done: true, reason: "Cargo nao existe mais." };
  if (!role.editable) return { done: false, reason: "Bot sem permissao/hierarquia para remover o cargo." };
  const member = await guild.members.fetch(entry.userId).catch(() => null);
  if (!member) return { done: true, reason: "Usuario saiu do servidor." };
  if (!member.roles.cache.has(entry.absenceRoleId)) return { done: true, reason: "Usuario ja nao possui o cargo." };
  await member.roles.remove(entry.absenceRoleId, "Retorno automatico de ausencia");
  return { done: true, reason: null };
}

async function notifyFinishedAbsence(guild: Guild, _context: BotContext, config: PoliceRhConfig, entry: PoliceRhPendingAbsenceRemoval) {
  const user = await guild.client.users.fetch(entry.userId).catch(() => null);
  await user?.send(renderComponentsV2Panel({
    accentColor: 0x22c55e,
    description: config.absenceDmFinishedMessage,
    moduleId: MODULE_ID,
    title: "⏰ Ausência finalizada"
  })).catch(() => null);
}

function logPendingAbsenceFailure(key: string, message: string) {
  const now = Date.now();
  const last = absenceReconcileFailureLogAt.get(key) ?? 0;
  if (now - last < 15 * 60_000) return;
  absenceReconcileFailureLogAt.set(key, now);
  console.warn(message);
}

function parseReturnDate(value: string) {
  const trimmed = value.trim();
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]), 12, 0, 0);
  const iso = new Date(trimmed);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function parseReturnDateKey(value: string) {
  const trimmed = value.trim();
  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(trimmed);
  if (br) {
    const today = currentDateKey();
    const year = br[3] ? Number(br[3]) : Number(today.slice(0, 4));
    const month = Number(br[2]);
    const day = Number(br[1]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function currentDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric"
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function readPendingAbsenceRemovals(value: unknown): PoliceRhPendingAbsenceRemoval[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const absenceRoleId = readString(record.absenceRoleId);
      const approvedAt = readString(record.approvedAt);
      const returnDate = readString(record.returnDate);
      const returnDateKey = readString(record.returnDateKey) ?? (returnDate ? parseReturnDateKey(returnDate) : null);
      const userId = readString(record.userId);
      if (!absenceRoleId || !approvedAt || !returnDate || !returnDateKey || !userId) return null;
      return {
        absenceRoleId,
        approvedAt,
        approvedBy: readString(record.approvedBy),
        returnDate,
        returnDateKey,
        userId
      };
    })
    .filter((item): item is PoliceRhPendingAbsenceRemoval => Boolean(item))
    .slice(0, 500);
}

function pendingAbsenceKey(entry: PoliceRhPendingAbsenceRemoval) {
  return `${entry.userId}:${entry.absenceRoleId}:${entry.returnDateKey}`;
}

function withEmoji(value: string, emoji: string) {
  return value.trim().startsWith(emoji) || /\p{Extended_Pictographic}/u.test(value.slice(0, 4)) ? value : `${emoji} ${value}`;
}

function visual(imageUrl: string, imagePosition: PanelVisualPosition): PanelVisualConfig | null {
  return imageUrl ? { imageEnabled: true, imagePosition, imageUrl } : null;
}
async function loadPanelVisual(context: BotContext, guildId: string, panelId: string): Promise<{ imagePosition: PanelVisualPosition; imageUrl: string }> {
  const settings = await context.api.getPanelVisualSettings(guildId, panelId).catch(() => null);
  if (!settings?.imageEnabled || !settings.imageUrl) return { imagePosition: "none", imageUrl: "" };
  return {
    imagePosition: readImagePosition(settings.imagePosition, "top"),
    imageUrl: settings.imageUrl
  };
}
function readString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function idList(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function uniqueIds(value: string[]) { return [...new Set(value.filter((item) => /^\d{5,32}$/.test(item)))]; }
function readImagePosition(value: unknown, fallback: PanelVisualPosition = "side"): PanelVisualPosition {
  return typeof value === "string" && ["banner", "thumbnail", "top", "below_title", "middle", "bottom", "side", "footer", "before_buttons", "below_text", "above_buttons", "none"].includes(value) ? value as PanelVisualPosition : fallback;
}
function colorToInt(value: string) { return Number.parseInt(value.replace("#", ""), 16) || 0x7c3aed; }
function validLinkUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}
function formatAdornmentDate(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric"
  }).format(value).replace(",", "");
}
function safeChannelName(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "rh"; }
async function writeLog(context: BotContext, guildId: string, userId: string | null, type: string, message: string, metadata?: unknown) {
  await context.api.postLog({ guildId, userId, type, message, metadata }).catch(() => undefined);
  const guild = context.client.guilds.cache.get(guildId);
  if (!guild) return;
  const config = await loadConfig(guildId, context).catch(() => null);
  if (!config) return;
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const isAdornment = type.includes("adorno");
  const isAbsence = type.includes("absence");
  const channelId = isAdornment
    ? config.adornoLogChannelId ?? config.rhLogChannelId
    : isAbsence
      ? config.absenceLogChannelId ?? config.rhLogChannelId
      : config.rhLogChannelId;
  const imageUrl = typeof record.imageUrl === "string" && validLinkUrl(record.imageUrl)
    ? record.imageUrl
    : isAdornment
      ? config.adornoImageUrl || config.adornoBannerUrl
      : config.absenceImageUrl || config.absenceBannerUrl;

  await sendPoliceLog(guild, [channelId], {
    action: message,
    actorId: userId,
    channelId: typeof record.channelId === "string" ? record.channelId : null,
    color: isAdornment ? 0x22c55e : isAbsence ? 0xf59e0b : 0x7c3aed,
    fields: [
      { name: "Sistema", value: isAdornment ? "RH - Adorno" : isAbsence ? "RH - Ausência" : "RH" },
      { name: "Solicitante", value: typeof record.requesterId === "string" ? `<@${record.requesterId}> | ${record.requesterId}` : userId ? `<@${userId}> | ${userId}` : null },
      { name: "Detalhes", value: formatRecordDetails(record) }
    ],
    image: imageUrl ? visual(imageUrl, isAdornment ? config.adornoImagePosition : config.absenceImagePosition) : null,
    title: "RH"
  });
}

function formatRecordDetails(record: Record<string, unknown>) {
  const ignored = new Set(["channelId", "imageUrl"]);
  const lines = Object.entries(record)
    .filter(([key, value]) => !ignored.has(key) && value !== null && value !== undefined && value !== "")
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  return lines.length ? lines.join("\n") : "-";
}
