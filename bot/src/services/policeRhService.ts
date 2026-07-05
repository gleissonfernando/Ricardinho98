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
  type Client,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";
import { renderComponentsV2Panel, type PanelVisualConfig, type PanelVisualPosition } from "./panelVisualRenderer";

const MODULE_ID = "police-rh";
const PREFIX = "police_rh";

type PoliceRhConfig = {
  enabled: boolean;
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelTitle: string;
  panelDescription: string;
  panelColor: string;
  panelImageUrl: string;
  panelImagePosition: PanelVisualPosition;
  panelFooterText: string;
  panelFooterImageUrl: string;
  absenceEnabled: boolean;
  absenceCategoryId: string | null;
  absenceLogChannelId: string | null;
  absenceRoleId: string | null;
  absenceApproverRoleIds: string[];
  absenceDmApprovedMessage: string;
  absenceDmRejectedMessage: string;
  absenceDmFinishedMessage: string;
  adornoEnabled: boolean;
  adornoCategoryId: string | null;
  adornoLogChannelId: string | null;
  adornoApproverRoleIds: string[];
  adornoResponsibleRoleIds: string[];
  adornoDmApprovedMessage: string;
  adornoDmRejectedMessage: string;
  rhLogChannelId: string | null;
};

export function startPoliceRhService(client: Client<true>, context: BotContext) {
  context.socket.onPoliceRhPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;
    void publishPoliceRhPanel(guild, context, payload.action === "publish").catch((error) => {
      console.warn("[police-rh] falha ao publicar painel:", error instanceof Error ? error.message : error);
    });
  });
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
    await interaction.showModal(adornoModal());
    return true;
  }
  if (interaction.isModalSubmit() && action === "absence_submit") {
    await createRhRequestChannel(interaction, context, config, "absence");
    return true;
  }
  if (interaction.isModalSubmit() && action === "adorno_submit") {
    await createRhRequestChannel(interaction, context, config, "adorno");
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
    image: visual(config.panelImageUrl, config.panelImagePosition),
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
      inputRow("adornmentType", "🎖️ Tipo de adorno", "Ex: máscara, roupa, acessório"),
      inputRow("description", "📝 Descrição do adorno", "Descreva o adorno", TextInputStyle.Paragraph),
      inputRow("reason", "📌 Motivo da solicitação", "Explique o motivo", TextInputStyle.Paragraph),
      inputRow("imageUrl", "🖼️ Link da imagem", "https://...")
    );
}

function inputRow(id: string, label: string, placeholder: string, style: TextInputStyle = TextInputStyle.Short) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setRequired(id !== "imageUrl").setStyle(style).setMaxLength(style === TextInputStyle.Paragraph ? 1000 : 200)
  );
}

async function createRhRequestChannel(interaction: ModalSubmitInteraction, context: BotContext, config: PoliceRhConfig, type: "absence" | "adorno") {
  const categoryId = type === "absence" ? config.absenceCategoryId : config.adornoCategoryId;
  const approverRoleIds = type === "absence" ? config.absenceApproverRoleIds : uniqueIds([...config.adornoApproverRoleIds, ...config.adornoResponsibleRoleIds]);
  if (!categoryId) {
    await interaction.reply({ content: "📂 Categoria temporária não configurada.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild!;
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.editReply("❌ Categoria temporária inválida ou removida.");
    return;
  }
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  const returnDate = type === "absence" ? interaction.fields.getTextInputValue("returnDate") : "";
  const channel = await guild.channels.create({
    name: safeChannelName(`${type}-${interaction.user.username}`),
    parent: category.id,
    topic: `${PREFIX}|${type}|${interaction.user.id}|${Date.now()}|${encodeURIComponent(returnDate)}`.slice(0, 1024),
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }] : []),
      ...approverRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }))
    ],
    reason: `Solicitacao RH criada por ${interaction.user.tag}`
  });
  const fields = type === "absence"
    ? [
        `**👤 Solicitante:** <@${interaction.user.id}>`,
        `**📅 Início:** ${interaction.fields.getTextInputValue("startDate")}`,
        `**📅 Retorno:** ${interaction.fields.getTextInputValue("returnDate")}`,
        `**📝 Motivo:** ${interaction.fields.getTextInputValue("reason")}`,
        "**⏳ Status:** Aguardando análise"
      ]
    : [
        `**👤 Solicitante:** <@${interaction.user.id}>`,
        `**🎖️ Tipo:** ${interaction.fields.getTextInputValue("adornmentType")}`,
        `**📝 Descrição:** ${interaction.fields.getTextInputValue("description")}`,
        `**📌 Motivo:** ${interaction.fields.getTextInputValue("reason")}`,
        `**🖼️ Imagem:** ${interaction.fields.getTextInputValue("imageUrl") || "Não informado"}`,
        "**⏳ Status:** Aguardando análise"
      ];
  await channel.send({
    allowedMentions: { roles: approverRoleIds, users: [interaction.user.id] },
    content: [`<@${interaction.user.id}>`, ...approverRoleIds.map((roleId) => `<@&${roleId}>`)].join(" ")
  }).catch(() => null);
  await channel.send(requestPanelPayload(config, type, fields));
  await writeLog(context, guild.id, interaction.user.id, `police-rh.${type}.created`, `📋 Solicitação de ${type === "absence" ? "ausência" : "adorno"} criada.`, { channelId: channel.id, fields });
  await interaction.editReply(`✅ Solicitação criada: <#${channel.id}>`);
}

function requestPanelPayload(config: PoliceRhConfig, type: "absence" | "adorno", fields: string[], status = "⏳ Pendente") {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:approve`).setEmoji("✅").setLabel(type === "absence" ? "Aprovar Ausência" : "Aprovar Adorno").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:reject`).setEmoji("❌").setLabel(type === "absence" ? "Recusar Ausência" : "Recusar Adorno").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}:close`).setEmoji("🔒").setLabel("Fechar Canal").setStyle(ButtonStyle.Secondary)
  );
  return renderComponentsV2Panel({
    accentColor: type === "absence" ? 0xf59e0b : 0x22c55e,
    actions: [buttons],
    description: `📌 Status: **${status}**`,
    fields,
    moduleId: MODULE_ID,
    title: type === "absence" ? "📋 Solicitação de Ausência criada" : "🎖️ Solicitação de Adorno criada"
  });
}

async function handleReviewAction(interaction: ButtonInteraction, context: BotContext, config: PoliceRhConfig, action: "approve" | "reject" | "close") {
  if (!interaction.guild || !interaction.channel || !("topic" in interaction.channel)) return;
  const topic = parseTopic(String(interaction.channel.topic ?? ""));
  if (!topic) return;
  const allowedRoles = topic.type === "absence" ? config.absenceApproverRoleIds : uniqueIds([...config.adornoApproverRoleIds, ...config.adornoResponsibleRoleIds]);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const allowed = Boolean(member?.permissions.has(PermissionFlagsBits.Administrator) || allowedRoles.some((roleId) => member?.roles.cache.has(roleId)));
  if (!allowed) {
    await interaction.reply({ content: "❌ Apenas cargos aprovadores configurados podem executar esta ação.", ephemeral: true });
    return;
  }
  if (action === "close") {
    await interaction.reply({ content: "🔒 Canal será fechado.", ephemeral: true });
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-rh.closed", "🔒 Canal RH fechado.", { channelId: interaction.channel.id, requesterId: topic.userId, type: topic.type });
    setTimeout(() => void interaction.channel?.delete("Canal RH fechado").catch(() => null), 1500);
    return;
  }
  const approved = action === "approve";
  if (approved && topic.type === "absence" && config.absenceRoleId) {
    const requester = await interaction.guild.members.fetch(topic.userId).catch(() => null);
    await requester?.roles.add(config.absenceRoleId, `Ausência aprovada por ${interaction.user.tag}`).catch(() => null);
    scheduleAbsenceRoleRemoval(interaction.guild, context, config, topic.userId, topic.returnDate);
  }
  const dmMessage = topic.type === "absence"
    ? approved ? config.absenceDmApprovedMessage : config.absenceDmRejectedMessage
    : approved ? config.adornoDmApprovedMessage : config.adornoDmRejectedMessage;
  await sendDm(interaction, topic.userId, approved ? "✅ Solicitação aprovada" : "❌ Solicitação recusada", dmMessage, approved ? 0x22c55e : 0xef4444);
  await writeLog(context, interaction.guild.id, interaction.user.id, `police-rh.${topic.type}.${approved ? "approved" : "rejected"}`, `${approved ? "✅" : "❌"} Solicitação de ${topic.type === "absence" ? "ausência" : "adorno"} ${approved ? "aprovada" : "recusada"}.`, { channelId: interaction.channel.id, requesterId: topic.userId });
  await interaction.reply({ content: `${approved ? "✅" : "❌"} Solicitação ${approved ? "aprovada" : "recusada"}.`, ephemeral: true });
}

async function loadConfig(guildId: string, context: BotContext): Promise<PoliceRhConfig | null> {
  const botId = currentRuntimeBotId();
  if (!botId) return null;
  const runtime = await context.api.getBotGuildConfig(botId, guildId);
  const raw = runtime.modules[MODULE_ID] ?? {};
  return {
    enabled: raw.enabled === true,
    panelChannelId: readString(raw.panelChannelId) ?? readString(raw.rhPanelChannelId) ?? readString(raw.absencePanelChannelId) ?? readString(raw.adornoPanelChannelId),
    panelMessageId: readString(raw.panelMessageId),
    panelTitle: readString(raw.panelTitle) ?? "🏢 RH - Ausências e Adornos",
    panelDescription: readString(raw.panelDescription) ?? "📋 Selecione uma das opções abaixo para abrir sua solicitação.\nCada pedido será analisado pela equipe responsável antes de ser processado.",
    panelColor: readString(raw.panelColor) ?? "#7c3aed",
    panelImageUrl: readString(raw.panelImageUrl) ?? "",
    panelImagePosition: readImagePosition(raw.panelImagePosition),
    panelFooterText: readString(raw.panelFooterText) ?? "📌 RH - Sistema interno",
    panelFooterImageUrl: readString(raw.panelFooterImageUrl) ?? "",
    absenceEnabled: raw.absenceEnabled !== false,
    absenceCategoryId: readString(raw.absenceCategoryId),
    absenceLogChannelId: readString(raw.absenceLogChannelId),
    absenceRoleId: readString(raw.absenceRoleId),
    absenceApproverRoleIds: idList(raw.absenceApproverRoleIds),
    absenceDmApprovedMessage: readString(raw.absenceDmApprovedMessage) ?? "✅ Sua solicitação de ausência foi aprovada.\n⏰ Quando chegar a data de retorno, seu cargo de ausência será removido automaticamente.",
    absenceDmRejectedMessage: readString(raw.absenceDmRejectedMessage) ?? "❌ Sua solicitação de ausência foi recusada.",
    absenceDmFinishedMessage: readString(raw.absenceDmFinishedMessage) ?? "⏰ Sua ausência acabou. Você pode voltar ao RP/trabalho.",
    adornoEnabled: raw.adornoEnabled !== false,
    adornoCategoryId: readString(raw.adornoCategoryId),
    adornoLogChannelId: readString(raw.adornoLogChannelId),
    adornoApproverRoleIds: idList(raw.adornoApproverRoleIds),
    adornoResponsibleRoleIds: idList(raw.adornoResponsibleRoleIds),
    adornoDmApprovedMessage: readString(raw.adornoDmApprovedMessage) ?? "✅ Sua solicitação de adorno foi aprovada.",
    adornoDmRejectedMessage: readString(raw.adornoDmRejectedMessage) ?? "❌ Sua solicitação de adorno foi recusada.",
    rhLogChannelId: readString(raw.rhLogChannelId)
  };
}

async function sendDm(interaction: ButtonInteraction, userId: string, title: string, description: string, color: number) {
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  await user?.send(renderComponentsV2Panel({ accentColor: color, description, moduleId: MODULE_ID, title })).catch(() => null);
}

function parseTopic(topic: string) {
  const [prefix, type, userId, , encodedReturnDate] = topic.split("|");
  if (prefix !== PREFIX || (type !== "absence" && type !== "adorno") || !/^\d{5,32}$/.test(userId ?? "")) return null;
  return { returnDate: encodedReturnDate ? decodeURIComponent(encodedReturnDate) : null, type, userId: userId as string };
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

function parseReturnDate(value: string) {
  const trimmed = value.trim();
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]), 12, 0, 0);
  const iso = new Date(trimmed);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function withEmoji(value: string, emoji: string) {
  return value.trim().startsWith(emoji) || /\p{Extended_Pictographic}/u.test(value.slice(0, 4)) ? value : `${emoji} ${value}`;
}

function visual(imageUrl: string, imagePosition: PanelVisualPosition): PanelVisualConfig | null {
  return imageUrl ? { imageEnabled: true, imagePosition, imageUrl } : null;
}
function readString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function idList(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function uniqueIds(ids: string[]) { return [...new Set(ids.filter((id) => /^\d{5,32}$/.test(id)))]; }
function readImagePosition(value: unknown): PanelVisualPosition {
  return typeof value === "string" && ["top", "middle", "side", "footer", "none"].includes(value) ? value as PanelVisualPosition : "side";
}
function colorToInt(value: string) { return Number.parseInt(value.replace("#", ""), 16) || 0x7c3aed; }
function safeChannelName(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "rh"; }
async function writeLog(context: BotContext, guildId: string, userId: string | null, type: string, message: string, metadata?: unknown) {
  await context.api.postLog({ guildId, userId, type, message, metadata }).catch(() => undefined);
}
