import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  StringSelectMenuOptionBuilder,
  type StringSelectMenuInteraction,
  type Client,
  type Guild,
  type Interaction
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import { renderComponentsV2Panel } from "./panelVisualRenderer";
import type { PanelVisualPosition } from "./panelVisualRenderer";

const MODULE_ID = "police-reports";
const PREFIX = "police_reports";
const PAGE_SIZE = 25;

type ComplaintType = { id: string; name: string; description: string | null; emoji: string | null; order: number };
type PoliceReportsConfig = {
  enabled: boolean;
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelTitle: string;
  panelDescription: string;
  buttonLabel: string;
  color: string;
  thumbnailUrl: string;
  categoryId: string | null;
  logChannelId: string | null;
  responsibleRoleIds: string[];
  responsibleRoleId: string | null;
  maxChannelMinutes: number;
  initialMessage: string;
  procedureText: string;
  panelImageUrl: string;
  channelImageUrl: string;
  footerImageUrl: string;
  imagePosition: PanelVisualPosition;
  complaintTypes: ComplaintType[];
};

export const policeReportsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("config_denuncias")
    .setDescription("Gerencia o painel de denuncias EAB.")
    .addSubcommand((command) => command.setName("publicar").setDescription("Publica ou atualiza o painel configurado.")),
  moduleId: MODULE_ID,
  async execute(interaction, context) {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Voce precisa da permissao Gerenciar Servidor.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      await publishPoliceReportsPanel(interaction.guild, context, true);
      await interaction.editReply("Painel de denuncias publicado ou atualizado.");
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "Nao foi possivel publicar o painel.");
    }
  }
};

export function startPoliceReportsService(client: Client<true>, context: BotContext) {
  context.socket.onPoliceReportsPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (guild) void publishPoliceReportsPanel(guild, context, payload.action === "publish").catch((error) => {
      console.warn("[police-reports] falha ao atualizar painel:", error instanceof Error ? error.message : error);
    });
  });
}

export async function handlePoliceReportsInteraction(interaction: Interaction, context: BotContext) {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guild || !isBotModuleEnabled(MODULE_ID)) return true;
  const config = await loadConfig(interaction.guild.id, context);
  if (!config) {
    await interaction.reply({ content: "A configuracao deste painel nao esta disponivel.", ephemeral: true });
    return true;
  }
  if (interaction.isStringSelectMenu()) {
    const selected = config.complaintTypes.find((item) => item.id === interaction.values[0]);
    if (!selected) {
      await interaction.reply({ content: "Este tipo de denuncia nao esta mais disponivel.", ephemeral: true });
      return true;
    }
    await createTemporaryProcedureChannel(interaction, context, config, selected);
    return true;
  }
  const action = interaction.customId.split(":")[1];
  if (["approve", "reject", "finish", "close"].includes(action ?? "")) {
    await handleProcedureAction(interaction, context, config, action!);
    return true;
  }
  const page = Math.max(0, Number(interaction.customId.split(":")[2] ?? 0) || 0);
  await interaction.update(createPanelPayload(config, page));
  return true;
}

async function publishPoliceReportsPanel(guild: Guild, context: BotContext, allowCreate: boolean) {
  const config = await loadConfig(guild.id, context);
  if (!config?.enabled) throw new Error("Ative o Sistema de Denuncias EAB antes de publicar.");
  if (!config.complaintTypes.length) throw new Error("Cadastre ao menos um tipo de denuncia antes de publicar o painel.");
  if (!config.panelChannelId) throw new Error("Configure o canal do painel antes de publicar.");
  if (!config.categoryId) throw new Error("Configure a categoria dos canais temporarios antes de publicar.");
  const channel = await guild.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel || !("messages" in channel) || !("send" in channel)) throw new Error("O canal configurado nao aceita mensagens.");
  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  if (message) {
    await message.edit(createPanelPayload(config, 0));
  } else if (allowCreate) {
    message = await channel.send(createPanelPayload(config, 0));
  }
  if (message && message.id !== config.panelMessageId) await context.api.updatePoliceReportsPanelState(guild.id, message.id);
}

async function loadConfig(guildId: string, context: BotContext): Promise<PoliceReportsConfig | null> {
  const botId = currentRuntimeBotId();
  if (!botId) return null;
  const runtime = await context.api.getBotGuildConfig(botId, guildId);
  const [mainVisual, channelVisual, footerVisual] = await Promise.all([
    context.api.getPanelVisualSettings(guildId, "police-reports").catch(() => null),
    context.api.getPanelVisualSettings(guildId, "police-reports-banner-2").catch(() => null),
    context.api.getPanelVisualSettings(guildId, "police-reports-banner-3").catch(() => null)
  ]);
  const raw = runtime.modules[MODULE_ID] ?? {};
  const complaintTypes = Array.isArray(raw.complaintTypes)
    ? raw.complaintTypes.filter(isComplaintType).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    : [];
  return {
    enabled: raw.enabled === true,
    panelChannelId: readString(raw.panelChannelId),
    panelMessageId: readString(raw.panelMessageId),
    panelTitle: readString(raw.panelTitle) ?? "Sistema de Denuncias EAB",
    panelDescription: readString(raw.panelDescription) ?? "Registre uma denuncia de forma segura e sigilosa.",
    buttonLabel: readString(raw.buttonLabel) ?? "Selecionar denuncia",
    color: readString(raw.color) ?? "#7c3aed",
    thumbnailUrl: readString(raw.thumbnailUrl) ?? "",
    categoryId: readString(raw.categoryId),
    logChannelId: readString(raw.logChannelId),
    responsibleRoleId: readString(raw.responsibleRoleId),
    responsibleRoleIds: readStringArray(raw.responsibleRoleIds),
    maxChannelMinutes: Math.max(1, Number(raw.maxChannelMinutes) || 1440),
    initialMessage: readString(raw.initialMessage) ?? "A equipe responsavel vai dar continuidade ao procedimento por este canal.",
    procedureText: readString(raw.procedureText) ?? "Descreva o ocorrido com detalhes e aguarde a analise da equipe responsavel.",
    panelImageUrl: readString(raw.panelImageUrl) ?? readEnabledImageUrl(mainVisual) ?? "",
    channelImageUrl: readString(raw.channelImageUrl) ?? readEnabledImageUrl(channelVisual) ?? "",
    footerImageUrl: readString(raw.footerImageUrl) ?? readEnabledImageUrl(footerVisual) ?? "",
    imagePosition: readImagePosition(raw.imagePosition ?? mainVisual?.imagePosition),
    complaintTypes
  };
}

function createPanelPayload(config: PoliceReportsConfig, requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(config.complaintTypes.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount - 1);
  const visibleTypes = config.complaintTypes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:select:${page}`)
    .setPlaceholder(config.buttonLabel.slice(0, 150))
    .addOptions(visibleTypes.map(toSelectOption));
  const actions: unknown[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
  if (pageCount > 1) {
    actions.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:page:${Math.max(0, page - 1)}`).setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`${PREFIX}:page:${Math.min(pageCount - 1, page + 1)}`).setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1)
    ));
  }
  return renderComponentsV2Panel({
    accentColor: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    actions,
    description: `${config.panelDescription}${pageCount > 1 ? `\n\nPagina ${page + 1} de ${pageCount}` : ""}`,
    fields: [],
    image: panelImage(config.panelImageUrl || config.thumbnailUrl, config.imagePosition),
    extraImages: [panelImage(config.footerImageUrl, "footer")],
    moduleId: MODULE_ID,
    title: config.panelTitle
  });
}

async function createTemporaryProcedureChannel(
  interaction: StringSelectMenuInteraction,
  context: BotContext,
  config: PoliceReportsConfig,
  selected: ComplaintType
) {
  if (!interaction.guild) return;
  if (!config.enabled) {
    await interaction.reply({ content: "O Sistema de Denuncias EAB esta desativado.", ephemeral: true });
    return;
  }
  if (!config.categoryId) {
    await interaction.reply({ content: "O sistema precisa ser configurado na dashboard: selecione a categoria dos canais temporarios.", ephemeral: true });
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.config_missing", "Categoria temporaria nao configurada.", { selectedType: selected.id });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const category = await interaction.guild.channels.fetch(config.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.editReply("A categoria configurada para denuncias nao foi encontrada.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_create_failed", "Categoria configurada invalida.", { categoryId: config.categoryId });
    return;
  }

  const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
  const responsibleRoleIds = uniqueIds([...config.responsibleRoleIds, config.responsibleRoleId].filter(Boolean) as string[]);
  const missingRoles = responsibleRoleIds.filter((roleId) => !interaction.guild!.roles.cache.has(roleId));
  if (missingRoles.length) {
    await interaction.editReply("Um ou mais cargos responsaveis configurados nao existem mais no servidor.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.config_invalid", "Cargo responsavel nao encontrado.", { missingRoles });
    return;
  }
  const missingPermissions = me?.permissions.missing([
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]) ?? ["ManageChannels"];
  if (missingPermissions.length) {
    await interaction.editReply("O bot nao tem permissao para criar canais ou enviar paineis nessa categoria.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_create_failed", "Permissoes insuficientes para criar canal temporario.", { missingPermissions });
    return;
  }

  try {
    const channel = await interaction.guild.channels.create({
      name: safeChannelName(`denuncia-${interaction.user.username}`),
      parent: category.id,
      topic: `${PREFIX}|${interaction.user.id}|${selected.name}|${Date.now() + config.maxChannelMinutes * 60_000}`.slice(0, 1024),
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }] : []),
        ...responsibleRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }))
      ],
      reason: `Denuncia EAB criada por ${interaction.user.tag}`
    });
    const mentions = [`<@${interaction.user.id}>`, ...responsibleRoleIds.map((roleId) => `<@&${roleId}>`)];
    if (mentions.length) {
      await channel.send({
        allowedMentions: { roles: responsibleRoleIds, users: [interaction.user.id] },
        content: mentions.join(" ")
      });
    }
    const panel = await channel.send(createProcedurePanel(config, selected, interaction.user.id, interaction.user.tag, "Pendente"));
    scheduleChannelExpiry(channel.id, interaction.guild.id, config.maxChannelMinutes, context);
    await interaction.editReply(`Canal temporario criado: <#${channel.id}>`);
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_created", "Canal temporario de denuncia criado.", { channelId: channel.id, messageId: panel.id, selectedType: selected.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply("Nao foi possivel criar o canal temporario. A equipe foi avisada nos logs.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_create_failed", "Erro ao criar canal temporario de denuncia.", { error: message, selectedType: selected.name });
  }
}

async function handleProcedureAction(
  interaction: ButtonInteraction,
  context: BotContext,
  config: PoliceReportsConfig,
  action: string
) {
  if (!interaction.guild || !interaction.channel || !("topic" in interaction.channel)) return;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const responsibleRoleIds = uniqueIds([...config.responsibleRoleIds, config.responsibleRoleId].filter(Boolean) as string[]);
  const allowed = Boolean(member?.permissions.has(PermissionFlagsBits.Administrator) || responsibleRoleIds.some((roleId) => member?.roles.cache.has(roleId)));
  if (!allowed) {
    await interaction.reply({ content: "Apenas responsaveis configurados podem executar esta acao.", ephemeral: true });
    return;
  }
  const [, requesterId, typeName] = String(interaction.channel.topic ?? "").split("|");
  const status = action === "approve" ? "Aprovado" : action === "reject" ? "Recusado" : action === "finish" ? "Finalizado" : "Fechado";
  await writeLog(context, interaction.guild.id, interaction.user.id, `police-reports.${action}`, `Procedimento ${status.toLowerCase()}.`, {
    channelId: interaction.channel.id,
    requesterId,
    typeName
  });
  if (action === "close") {
    await interaction.reply({ content: "Canal sera deletado.", ephemeral: true });
    await interaction.channel.delete(`Denuncia EAB fechada por ${interaction.user.tag}`).catch(() => null);
    return;
  }
  await interaction.update(createProcedurePanel(config, { id: "", name: typeName || "Denuncia", description: null, emoji: null, order: 0 }, requesterId || "desconhecido", requesterId || "Usuario", status));
}

function createProcedurePanel(config: PoliceReportsConfig, selected: ComplaintType, userId: string, username: string, status: string) {
  const createdAt = Math.floor(Date.now() / 1000);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:approve`).setLabel("Aprovar").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:reject`).setLabel("Recusar").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}:finish`).setLabel("Finalizar").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:close`).setLabel("Fechar").setStyle(ButtonStyle.Secondary)
  );
  return renderComponentsV2Panel({
    accentColor: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    actions: [buttons],
    description: config.initialMessage,
    fields: [
      `**Usuario:** <@${userId}>\n**ID:** ${userId}\n**Tipo:** ${selected.name}\n**Status:** ${status}\n**Solicitado em:** <t:${createdAt}:F>`,
      config.procedureText
    ],
    image: panelImage(config.channelImageUrl || config.panelImageUrl || config.thumbnailUrl, config.imagePosition),
    extraImages: [panelImage(config.footerImageUrl, "footer")],
    moduleId: MODULE_ID,
    title: "Procedimento EAB"
  });
}

function toSelectOption(item: ComplaintType) {
  const option = new StringSelectMenuOptionBuilder().setLabel(item.name.slice(0, 100)).setValue(item.id.slice(0, 100));
  if (item.description) option.setDescription(item.description.slice(0, 100));
  if (item.emoji) {
    try { option.setEmoji(item.emoji); } catch { /* Emoji invalido nao impede o painel. */ }
  }
  return option;
}

function isComplaintType(value: unknown): value is ComplaintType {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ComplaintType>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.order === "number";
}

function readString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function readEnabledImageUrl(value: { imageEnabled?: boolean; imageUrl?: string | null } | null) { return value?.imageEnabled && value.imageUrl ? value.imageUrl : null; }
function readStringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function readImagePosition(value: unknown): PanelVisualPosition {
  return typeof value === "string" && ["banner", "thumbnail", "top", "below_title", "middle", "bottom", "side", "footer", "before_buttons", "below_text", "above_buttons", "none"].includes(value) ? value as PanelVisualPosition : "banner";
}
function panelImage(imageUrl: string, imagePosition: PanelVisualPosition) { return imageUrl ? { imageEnabled: true, imagePosition, imageUrl } : null; }
function uniqueIds(ids: string[]) { return [...new Set(ids.filter((id) => /^\d{5,32}$/.test(id)))]; }
function safeChannelName(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "denuncia-eab"; }
async function writeLog(context: BotContext, guildId: string, userId: string | null, type: string, message: string, metadata?: unknown) {
  await context.api.postLog({ guildId, userId, type, message, metadata }).catch((error) => {
    console.warn("[police-reports] falha ao registrar log:", error instanceof Error ? error.message : error);
  });
}
function scheduleChannelExpiry(channelId: string, guildId: string, minutes: number, context: BotContext) {
  const delay = Math.min(Math.max(1, minutes) * 60_000, 2_147_000_000);
  setTimeout(() => {
    const guild = context.client.guilds.cache.get(guildId);
    void guild?.channels.fetch(channelId).then(async (channel) => {
      if (!channel || !("delete" in channel)) return;
      await channel.delete("Denuncia EAB expirada por tempo maximo").catch(() => null);
      await writeLog(context, guildId, null, "police-reports.channel_deleted", "Canal temporario deletado por tempo maximo.", { channelId, maxChannelMinutes: minutes });
    }).catch(() => null);
  }, delay).unref?.();
}
