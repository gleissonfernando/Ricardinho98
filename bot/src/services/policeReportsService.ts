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
  type Interaction,
  type Message
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import { renderComponentsV2Panel } from "./panelVisualRenderer";
import type { PanelVisualConfig, PanelVisualPosition } from "./panelVisualRenderer";
import { sendPoliceLog } from "./policeLogService";

const MODULE_ID = "police-reports";
const PREFIX = "police_reports";
const PAGE_SIZE = 25;
const IAB_WEBHOOK_NAME = "Human Resources - NPD";

type ComplaintType = { id: string; name: string; description: string | null; emoji: string | null; order: number };
type PoliceReportsConfig = {
  enabled: boolean;
  panelChannelId: string | null;
  panelChannelIds: string[];
  panelMessageId: string | null;
  panelTitle: string;
  panelDescription: string;
  buttonLabel: string;
  color: string;
  thumbnailUrl: string;
  categoryId: string | null;
  categoryIds: string[];
  archiveCategoryId: string | null;
  archiveCategoryIds: string[];
  logChannelId: string | null;
  logChannelIds: string[];
  responsibleRoleIds: string[];
  responsibleRoleId: string | null;
  maxChannelMinutes: number;
  initialMessage: string;
  procedureText: string;
  panelImageUrl: string;
  channelImageUrl: string;
  footerImageUrl: string;
  imagePosition: PanelVisualPosition;
  panelVisual: PanelVisualConfig | null;
  channelVisual: PanelVisualConfig | null;
  footerVisual: PanelVisualConfig | null;
  complaintTypes: ComplaintType[];
};

const DEFAULT_COMPLAINT_TYPES: ComplaintType[] = [
  { id: "denuncia-oficiais", name: "Denúncia de Oficiais", description: "Relatar conduta inadequada de oficiais.", emoji: "🚔", order: 1 },
  { id: "denuncia-alto-comando", name: "Denúncia de Alto Comando", description: "Relatar ocorrencias envolvendo alto comando.", emoji: "👮", order: 2 },
  { id: "corregedoria", name: "Corregedoria", description: "Encaminhamento direto para a corregedoria.", emoji: "⚖️", order: 3 },
  { id: "ouvidoria", name: "Ouvidoria", description: "Enviar manifestacoes, duvidas ou solicitacoes.", emoji: "📋", order: 4 },
  { id: "abuso-de-poder", name: "Abuso de Poder", description: "Denunciar abuso de autoridade ou uso indevido do cargo.", emoji: "🚨", order: 5 },
  { id: "assuntos-internos", name: "Assuntos Internos", description: "Abrir procedimento sigiloso de assuntos internos.", emoji: "🛡️", order: 6 }
];

function mergeDefaultComplaintTypes(types: ComplaintType[]) {
  const normalizedName = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const officialAliases = new Set(["denuncia de oficial", "denuncia de oficiais"]);
  const matched = new Set<string>();
  const required = DEFAULT_COMPLAINT_TYPES.map((fallback) => {
    const existing = types.find((item) => item.id === fallback.id || normalizedName(item.name) === normalizedName(fallback.name) || (fallback.id === "denuncia-oficiais" && officialAliases.has(normalizedName(item.name))));
    if (existing) matched.add(existing.id);
    return existing ? { ...fallback, ...existing, id: fallback.id, name: fallback.name, order: fallback.order } : fallback;
  });
  return [...required, ...types.filter((item) => !matched.has(item.id)).map((item, index) => ({ ...item, order: required.length + index + 1 }))];
}

export const policeReportsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("config_denuncias")
    .setDescription("Gerencia o painel de denuncias IAB.")
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
    const page = Math.max(0, Number(interaction.customId.split(":")[2] ?? 0) || 0);
    await interaction.update(createPanelPayload(config, page));
    await showIdentitySelection(interaction, selected);
    return true;
  }
  const action = interaction.customId.split(":")[1];
  if (action === "identity") {
    const [, , mode, selectedId] = interaction.customId.split(":");
    const selected = config.complaintTypes.find((item) => item.id === selectedId);
    if (!selected || (mode !== "anonymous" && mode !== "identified")) {
      await interaction.reply({ content: "Esta opcao de denuncia nao esta mais disponivel.", ephemeral: true });
      return true;
    }
    await createTemporaryProcedureChannel(interaction, context, config, selected, mode === "anonymous");
    return true;
  }
  if (["assume", "ping", "finish", "archive"].includes(action ?? "")) {
    await handleProcedureAction(interaction, context, config, action!);
    return true;
  }
  const page = Math.max(0, Number(interaction.customId.split(":")[2] ?? 0) || 0);
  await interaction.update(createPanelPayload(config, page));
  return true;
}

async function showIdentitySelection(interaction: StringSelectMenuInteraction, selected: ComplaintType) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:identity:identified:${selected.id}`).setLabel("Denuncia Identificada").setEmoji("👤").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:identity:anonymous:${selected.id}`).setLabel("Denuncia Anonima").setEmoji("🕵️").setStyle(ButtonStyle.Secondary)
  );
  await interaction.followUp({
    components: [{
      type: 17,
      accent_color: 0x7c3aed,
      components: [
        { type: 10, content: `# ${selected.name}\nEscolha obrigatoriamente como deseja registrar esta denuncia.` },
        buttons
      ]
    }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

async function publishPoliceReportsPanel(guild: Guild, context: BotContext, allowCreate: boolean) {
  const config = await loadConfig(guild.id, context);
  if (!config?.enabled) throw new Error("Ative o Sistema de Denuncias IAB antes de publicar.");
  if (!config.complaintTypes.length) throw new Error("Cadastre ao menos um tipo de denuncia antes de publicar o painel.");
  const panelChannelId = firstId(config.panelChannelIds, config.panelChannelId);
  if (!panelChannelId) throw new Error("Configure o canal do painel antes de publicar.");
  if (!firstId(config.categoryIds, config.categoryId)) throw new Error("Configure a categoria dos canais temporarios antes de publicar.");
  if (!firstId(config.archiveCategoryIds, config.archiveCategoryId)) throw new Error("Configure a categoria para onde o canal sera enviado depois de finalizado.");
  const channel = await guild.channels.fetch(panelChannelId).catch(() => null);
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
    panelChannelIds: idList(raw.panelChannelIds, readString(raw.panelChannelId)),
    panelMessageId: readString(raw.panelMessageId),
    panelTitle: readString(raw.panelTitle) ?? "Sistema de Denuncias IAB",
    panelDescription: readString(raw.panelDescription) ?? "Registre uma denuncia de forma segura e sigilosa.",
    buttonLabel: readString(raw.buttonLabel) ?? "Selecionar denuncia",
    color: readString(raw.color) ?? "#7c3aed",
    thumbnailUrl: readString(raw.thumbnailUrl) ?? "",
    categoryId: readString(raw.categoryId),
    categoryIds: idList(raw.categoryIds, readString(raw.categoryId)),
    archiveCategoryId: readString(raw.archiveCategoryId),
    archiveCategoryIds: idList(raw.archiveCategoryIds, readString(raw.archiveCategoryId)),
    logChannelId: readString(raw.logChannelId),
    logChannelIds: idList(raw.logChannelIds, readString(raw.logChannelId)),
    responsibleRoleId: readString(raw.responsibleRoleId),
    responsibleRoleIds: readStringArray(raw.responsibleRoleIds),
    maxChannelMinutes: Math.max(1, Number(raw.maxChannelMinutes) || 1440),
    initialMessage: readString(raw.initialMessage) ?? "A equipe responsavel vai dar continuidade ao procedimento por este canal.",
    procedureText: readString(raw.procedureText) ?? "Descreva o ocorrido com detalhes e aguarde a analise da equipe responsavel.",
    panelImageUrl: readString(raw.panelImageUrl) ?? readEnabledImageUrl(mainVisual) ?? "",
    channelImageUrl: readString(raw.channelImageUrl) ?? readEnabledImageUrl(channelVisual) ?? "",
    footerImageUrl: readString(raw.footerImageUrl) ?? readEnabledImageUrl(footerVisual) ?? "",
    imagePosition: readImagePosition(raw.imagePosition ?? mainVisual?.imagePosition),
    panelVisual: enabledVisual(mainVisual) ?? panelImage(readString(raw.panelImageUrl) ?? readString(raw.thumbnailUrl) ?? "", readImagePosition(raw.imagePosition)),
    channelVisual: enabledVisual(channelVisual) ?? panelImage(readString(raw.channelImageUrl) ?? "", readImagePosition(channelVisual?.imagePosition ?? raw.imagePosition)),
    footerVisual: enabledVisual(footerVisual) ?? panelImage(readString(raw.footerImageUrl) ?? "", "footer"),
    complaintTypes: mergeDefaultComplaintTypes(complaintTypes)
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
    footerIcon: config.footerVisual,
    footerText: `**NPD - IAB** · Selecione o tipo abaixo · <t:${Math.floor(Date.now() / 1000)}:f>`,
    headerText: "**North Police Department - Corregedoria**",
    image: config.panelVisual,
    moduleId: MODULE_ID,
    title: config.panelTitle
  });
}

async function createTemporaryProcedureChannel(
  interaction: ButtonInteraction,
  context: BotContext,
  config: PoliceReportsConfig,
  selected: ComplaintType,
  anonymous: boolean
) {
  if (!interaction.guild) return;
  if (!config.enabled) {
    await interaction.reply({ content: "O Sistema de Denuncias IAB esta desativado.", ephemeral: true });
    return;
  }
  const categoryId = firstId(config.categoryIds, config.categoryId);
  if (!categoryId) {
    await interaction.reply({ content: "O sistema precisa ser configurado na dashboard: selecione a categoria dos canais temporarios.", ephemeral: true });
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.config_missing", "Categoria temporaria nao configurada.", { selectedType: selected.id });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const category = await interaction.guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.editReply("A categoria configurada para denuncias nao foi encontrada.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_create_failed", "Categoria configurada invalida.", { categoryId });
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
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks
  ]) ?? ["ManageChannels"];
  if (missingPermissions.length) {
    await interaction.editReply("O bot nao tem permissao para criar canais ou enviar paineis nessa categoria.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_create_failed", "Permissoes insuficientes para criar canal temporario.", { missingPermissions });
    return;
  }

  try {
    const channel = await interaction.guild.channels.create({
      name: safeChannelName(anonymous ? `denuncia-anonima-${interaction.user.id.slice(-4)}` : `denuncia-${interaction.user.username}`),
      parent: category.id,
      topic: `${PREFIX}|ticket|${anonymous ? "anonymous" : "identified"}|${selected.id}|${Date.now() + config.maxChannelMinutes * 60_000}|${interaction.user.id}`.slice(0, 1024),
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] }] : []),
        ...responsibleRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }))
      ],
      reason: `Denuncia IAB criada por ${interaction.user.tag}`
    });
    const mentions = [...(anonymous ? [] : [`<@${interaction.user.id}>`]), ...responsibleRoleIds.map((roleId) => `<@&${roleId}>`)];
    if (mentions.length) {
      await channel.send({
        allowedMentions: { roles: responsibleRoleIds, users: anonymous ? [] : [interaction.user.id] },
        content: mentions.join(" ")
      });
    }
    const panel = await channel.send(createProcedurePanel(config, selected, interaction.user.id, anonymous, "Pendente"));
    await context.api.createTicket({
      anonymous,
      authorId: interaction.user.id,
      channelId: channel.id,
      guildId: interaction.guild.id,
      openerId: interaction.user.id,
      status: "aberto",
      subject: `Denuncia IAB - ${selected.name}`,
      ticketType: "denuncia"
    });
    scheduleChannelExpiry(channel.id, interaction.guild.id, config.maxChannelMinutes, context);
    await interaction.editReply(`Canal temporario criado: <#${channel.id}>`);
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_created", "Canal temporario de denuncia criado.", { anonymous, authorId: interaction.user.id, channelId: channel.id, createdAt: new Date().toISOString(), messageId: panel.id, selectedType: selected.name, ticketType: "denuncia" });
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
  const topic = parsePoliceReportTopic(String(interaction.channel.topic ?? ""));
  if (!topic) return;
  const { anonymous, selectedId } = topic;
  const requesterId = topic.requesterId ?? findRequesterId(interaction.channel, interaction.guild.members.me?.id);
  if (!requesterId) {
    await interaction.reply({ content: "Nao foi possivel identificar internamente o autor desta denuncia.", ephemeral: true });
    return;
  }
  const selected = config.complaintTypes.find((item) => item.id === selectedId) ?? { id: selectedId, name: "Denuncia", description: null, emoji: null, order: 0 };
  const status = action === "assume" ? "Em analise" : action === "finish" ? "Finalizado" : action === "archive" ? "Arquivado" : "Em analise";
  await writeLog(context, interaction.guild.id, interaction.user.id, `police-reports.${action}`, `Procedimento ${status.toLowerCase()}.`, {
    channelId: interaction.channel.id,
    requesterId,
    anonymous,
    typeName: selected.name
  });
  if (action === "assume") {
    await interaction.channel.send({
      allowedMentions: { parse: [] },
      components: [{
        type: 17,
        accent_color: Number.parseInt(config.color.replace("#", ""), 16) || 0x22c55e,
        components: [{ type: 10, content: "## ✅ Atendimento assumido\nA equipe IAB assumiu esta denuncia e dara continuidade a analise." }]
      }],
      flags: MessageFlags.IsComponentsV2
    }).catch(() => null);
    await interaction.update(createProcedurePanel(config, selected, requesterId, anonymous, status));
    return;
  }
  if (action === "ping") {
    const dmText = anonymous
      ? "🔔 A equipe IAB solicitou sua atencao em uma denuncia anonima.\n\nVoce pode responder normalmente pelo canal do ticket. Sua identidade continuara oculta."
      : `🔔 A equipe IAB solicitou sua atencao na denuncia ${interaction.channel}.\n\nAcesse o canal do ticket para continuar o atendimento.`;
    const user = await interaction.client.users.fetch(requesterId).catch(() => null);
    const dmSent = Boolean(await user?.send({ allowedMentions: { parse: [] }, content: dmText }).then(() => true).catch(() => false));
    await interaction.reply({
      content: anonymous
        ? `🔔 O denunciante anonimo foi notificado pela equipe IAB.${dmSent ? "" : "\nNao foi possivel entregar a DM; o privado pode estar fechado."}`
        : `🔔 O denunciante foi notificado pela equipe IAB.${dmSent ? "" : "\nNao foi possivel entregar a DM; o privado pode estar fechado."}`,
      ephemeral: false,
      allowedMentions: { parse: [] }
    });
    return;
  }
  if (action === "finish") {
    const archiveCategoryId = firstId(config.archiveCategoryIds, config.archiveCategoryId);
    if (!archiveCategoryId) {
      await interaction.reply({ content: "Configure a categoria de denuncias finalizadas na dashboard antes de finalizar.", ephemeral: true });
      await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.finish_failed", "Categoria de finalizacao nao configurada.", { channelId: interaction.channel.id });
      return;
    }
    const archiveCategory = await interaction.guild.channels.fetch(archiveCategoryId).catch(() => null);
    if (!archiveCategory || archiveCategory.type !== ChannelType.GuildCategory || !("setParent" in interaction.channel)) {
      await interaction.reply({ content: "A categoria de finalizacao configurada nao foi encontrada ou o canal nao pode ser movido.", ephemeral: true });
      await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.finish_failed", "Categoria de finalizacao invalida.", { archiveCategoryId, channelId: interaction.channel.id });
      return;
    }
    if (requesterId && /^\d{5,32}$/.test(requesterId) && "permissionOverwrites" in interaction.channel) {
      await interaction.channel.permissionOverwrites.edit(requesterId, {
        SendMessages: false,
        ViewChannel: false
      }, { reason: `Denuncia IAB finalizada por ${interaction.user.tag}` }).catch(async (error) => {
        await writeLog(context, interaction.guild!.id, interaction.user.id, "police-reports.requester_remove_failed", "Erro ao remover o autor do canal finalizado.", { channelId: interaction.channel!.id, error: error instanceof Error ? error.message : String(error), requesterId });
      });
    }
    await interaction.channel.setParent(archiveCategory.id, { lockPermissions: false, reason: `Denuncia IAB finalizada por ${interaction.user.tag}` });
    const archiveNumber = nextArchiveNumber(interaction.guild, archiveCategory.id);
    await interaction.channel.setName(`ticket-finalizado-denuncia-${String(archiveNumber).padStart(4, "0")}`, `Denuncia IAB finalizada por ${interaction.user.tag}`);
    await context.api.updateTicketStatus({ channelId: interaction.channel.id, guildId: interaction.guild.id, status: "finalizado" }).catch(async (error) => {
      await writeLog(context, interaction.guild!.id, interaction.user.id, "police-reports.status_update_failed", "Falha ao atualizar o status interno da denuncia.", { channelId: interaction.channel!.id, error: error instanceof Error ? error.message : String(error) });
    });
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_moved", "Canal de denuncia movido para categoria finalizada.", {
      archiveCategoryId: archiveCategory.id,
      channelId: interaction.channel.id,
      anonymous,
      finalizedBy: interaction.user.id,
      requesterId
    });
    await interaction.update(createProcedurePanel(config, selected, requesterId, anonymous, status));
    return;
  }
  if (action === "archive") {
    const logChannelId = firstId(config.logChannelIds, config.logChannelId);
    const target = logChannelId
      ? await interaction.guild.channels.fetch(logChannelId).catch(() => null)
      : interaction.channel;
    const payload = await createArchivePanel(config, selected, requesterId, anonymous, interaction.channel);
    if (target && "send" in target && !target.isDMBased()) {
      await target.send(payload).catch(async (error) => {
        await writeLog(context, interaction.guild!.id, interaction.user.id, "police-reports.archive_failed", "Falha ao enviar painel de arquivamento.", { channelId: interaction.channel!.id, error: error instanceof Error ? error.message : String(error) });
      });
    }
    await interaction.update(createProcedurePanel(config, selected, requesterId, anonymous, status));
    return;
  }
  await interaction.update(createProcedurePanel(config, selected, requesterId, anonymous, status));
}

function createProcedurePanel(config: PoliceReportsConfig, selected: ComplaintType, userId: string, anonymous: boolean, status: string) {
  const createdAt = Math.floor(Date.now() / 1000);
  const finished = status === "Finalizado";
  const archived = status === "Arquivado";
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:assume`).setLabel("Assumir").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(finished || archived),
    new ButtonBuilder().setCustomId(`${PREFIX}:ping`).setLabel("Toque").setEmoji("🔔").setStyle(ButtonStyle.Primary).setDisabled(finished || archived),
    new ButtonBuilder().setCustomId(`${PREFIX}:finish`).setLabel("Finalizar").setEmoji("🔒").setStyle(ButtonStyle.Danger).setDisabled(finished || archived),
    new ButtonBuilder().setCustomId(`${PREFIX}:archive`).setLabel("Arquivar").setEmoji("🗄️").setStyle(ButtonStyle.Secondary).setDisabled(archived)
  );
  return renderComponentsV2Panel({
    accentColor: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    actions: [buttons],
    description: config.initialMessage,
    fields: [
      `${anonymous ? "**Modo:** Denuncia Anonima" : `**Modo:** Denuncia Identificada\n**Usuario:** <@${userId}>\n**ID:** ${userId}`}\n**Tipo:** ${selected.name}\n**Status:** ${status}\n**Solicitado em:** <t:${createdAt}:F>`,
      config.procedureText
    ],
    image: config.channelVisual ?? config.panelVisual,
    footerIcon: config.footerVisual,
    footerText: `**NPD - IAB** · Procedimento aberto · <t:${createdAt}:f>`,
    moduleId: MODULE_ID,
    title: "Procedimento IAB"
  });
}

async function createArchivePanel(
  config: PoliceReportsConfig,
  selected: ComplaintType,
  requesterId: string,
  anonymous: boolean,
  channel: ButtonInteraction["channel"]
) {
  const fetched = channel && "messages" in channel
    ? await channel.messages.fetch({ limit: 50 }).catch(() => null)
    : null;
  const messages = fetched
    ? [...fetched.values()].reverse().filter((message) => !message.author.bot || message.attachments.size || message.content)
    : [];
  const evidence = uniqueStrings(messages.flatMap((message) => [
    ...message.attachments.map((attachment) => attachment.url),
    ...extractUrls(message.content)
  ])).slice(0, 10);
  const history = messages
    .filter((message) => message.content && !message.content.startsWith(`<@&`))
    .slice(-8)
    .map((message) => `- ${archiveHistoryAuthorLabel(message, requesterId, anonymous)}: ${message.content.replace(/\s+/g, " ").slice(0, 180)}`)
    .join("\n");
  const createdAt = Math.floor(Date.now() / 1000);
  return renderComponentsV2Panel({
    accentColor: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    description: `:info1: Denuncia - ${selected.name}`,
    fields: [
      `**Denunciante**\n${anonymous ? "Denuncia Anonima" : `<@${requesterId}> | ${requesterId}`}\n\n**Tipo**\n${selected.name}\n\n**Status**\nARQUIVADO\n\n**Arquivado por**\n${IAB_WEBHOOK_NAME}`,
      `**Data / Horario**\n<t:${createdAt}:F>\n\n**Evidencias**\n${evidence.length ? evidence.join("\n") : "Nenhuma evidencia encontrada no historico recente."}`,
      `**Historico recente**\n${history || "Sem mensagens textuais recentes."}`
    ],
    footerIcon: config.footerVisual,
    footerText: `**NPD - Contra Oficial** · denuncia arquivada · <t:${createdAt}:f>`,
    headerText: "**🏛️ North Police Department - Contra Oficial**",
    image: config.channelVisual ?? config.panelVisual,
    moduleId: MODULE_ID,
    title: `Denuncia - ${selected.name}`
  });
}

function archiveHistoryAuthorLabel(message: Message, requesterId: string, anonymous: boolean) {
  if (message.author.id === requesterId) return anonymous ? "Denunciante Anonimo" : "Denunciante";
  if (message.content.includes(`**${IAB_WEBHOOK_NAME}**`)) return IAB_WEBHOOK_NAME;
  if (message.content.includes("**Denunciante Anonimo**")) return "Denunciante Anonimo";
  return message.author.bot ? "Bot" : IAB_WEBHOOK_NAME;
}

export async function handlePoliceReportsMessage(message: Message, context: BotContext) {
  if (message.author.bot || !message.guild || !("topic" in message.channel)) return false;
  const ticket = parsePoliceReportTopic(String(message.channel.topic ?? ""));
  if (!ticket) return false;
  if (!("send" in message.channel)) return false;
  const requesterId = ticket.requesterId ?? findRequesterId(message.channel, message.guild.members.me?.id);
  const isAuthor = message.author.id === requesterId;
  const isStaff = !isAuthor;
  if (isAuthor && !ticket.anonymous) return false;

  const files = message.attachments.map((attachment) => ({ attachment: attachment.url, name: attachment.name ?? undefined }));
  const content = [
    isAuthor ? "**Denunciante Anonimo**" : "",
    message.content,
    ...message.stickers.map((sticker) => `[Sticker: ${sticker.name}]`)
  ].filter(Boolean).join("\n");
  const deleted = await message.delete().then(() => true).catch(() => false);
  if (isStaff) {
    try {
      const webhook = await getOrCreateIabWebhook(message);
      await webhook.send({
        allowedMentions: { parse: [] },
        avatarURL: message.client.user.displayAvatarURL({ size: 128 }),
        content: content || undefined,
        files,
        username: IAB_WEBHOOK_NAME
      });
    } catch (error) {
      await writeLog(context, message.guild!.id, message.author.id, "police-reports.relay_failed", "Falha ao retransmitir mensagem protegida.", { anonymous: ticket.anonymous, channelId: message.channel.id, error: error instanceof Error ? error.message : String(error), isStaff });
    }
  } else {
    await message.channel.send({ allowedMentions: { parse: [] }, content: content || "*Anexo enviado*", files }).catch(async (error) => {
      await writeLog(context, message.guild!.id, message.author.id, "police-reports.relay_failed", "Falha ao retransmitir mensagem protegida.", { anonymous: ticket.anonymous, channelId: message.channel.id, error: error instanceof Error ? error.message : String(error), isStaff });
    });
  }
  await writeLog(context, message.guild.id, message.author.id, "police-reports.protected_message", "Mensagem retransmitida sem expor identidade no canal.", { anonymous: ticket.anonymous, attachmentCount: message.attachments.size, channelId: message.channel.id, deleted, isStaff, selectedType: ticket.selectedId });
  return true;
}

async function getOrCreateIabWebhook(message: Message) {
  if (!("fetchWebhooks" in message.channel) || !("createWebhook" in message.channel)) {
    throw new Error("Canal IAB nao suporta webhook anonimo.");
  }
  const webhooks = await message.channel.fetchWebhooks();
  const existing = webhooks.find((webhook) => webhook.owner?.id === message.client.user.id && webhook.name === IAB_WEBHOOK_NAME);
  return existing ?? await message.channel.createWebhook({
    name: IAB_WEBHOOK_NAME,
    reason: "Proxy anonimo da Equipe IAB"
  });
}

function parsePoliceReportTopic(topic: string) {
  const [prefix, kind, mode, selectedId, , requesterId] = topic.split("|");
  if (prefix !== PREFIX || kind !== "ticket" || (mode !== "anonymous" && mode !== "identified") || !selectedId) return null;
  return { anonymous: mode === "anonymous", requesterId: requesterId && /^\d{5,32}$/.test(requesterId) ? requesterId : null, selectedId };
}

function findRequesterId(channel: { permissionOverwrites?: { cache: { find: (predicate: (overwrite: { id: string; type: number }) => boolean) => { id: string } | undefined } } }, botMemberId?: string) {
  return channel.permissionOverwrites?.cache.find((overwrite) => overwrite.type === 1 && overwrite.id !== botMemberId)?.id ?? null;
}

function nextArchiveNumber(guild: Guild, categoryId: string) {
  return guild.channels.cache
    .filter((channel) => channel.parentId === categoryId)
    .map((channel) => /^ticket-finalizado-denuncia-(\d+)$/.exec(channel.name)?.[1])
    .filter((value): value is string => Boolean(value))
    .reduce((highest, value) => Math.max(highest, Number(value)), 0) + 1;
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
function enabledVisual(value: PanelVisualConfig | null) { return value?.imageEnabled && value.imageUrl ? value : null; }
function readStringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function idList(value: unknown, fallback: string | null) { return uniqueIds([...readStringArray(value), ...(fallback ? [fallback] : [])]); }
function firstId(values: string[] | undefined, fallback: string | null | undefined) { return values?.[0] ?? fallback ?? null; }
function readImagePosition(value: unknown): PanelVisualPosition {
  return typeof value === "string" && ["banner", "thumbnail", "top", "below_title", "middle", "bottom", "side", "footer", "before_buttons", "below_text", "above_buttons", "none"].includes(value) ? value as PanelVisualPosition : "banner";
}
function panelImage(imageUrl: string, imagePosition: PanelVisualPosition) { return imageUrl ? { imageEnabled: true, imagePosition, imageUrl } : null; }
function uniqueIds(ids: string[]) { return [...new Set(ids.filter((id) => /^\d{5,32}$/.test(id)))]; }
function uniqueStrings(values: string[]) { return [...new Set(values.filter((value) => value.trim()))]; }
function extractUrls(value: string) { return value.match(/https?:\/\/\S+/gi) ?? []; }
function safeChannelName(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "denuncia-iab"; }
async function writeLog(context: BotContext, guildId: string, userId: string | null, type: string, message: string, metadata?: unknown) {
  await context.api.postLog({ guildId, userId, type, message, metadata }).catch((error) => {
    console.warn("[police-reports] falha ao registrar log:", error instanceof Error ? error.message : error);
  });
  const guild = context.client.guilds.cache.get(guildId);
  if (!guild) return;
  const config = await loadConfig(guildId, context).catch(() => null);
  if (!config) return;
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  await sendPoliceLog(guild, config.logChannelIds.length ? config.logChannelIds : [config.logChannelId], {
    action: message,
    actorId: userId,
    channelId: typeof record.channelId === "string" ? record.channelId : null,
    color: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    fields: [
      { name: "Sistema", value: "Denúncias IAB" },
      { name: "Tipo", value: typeof record.selectedType === "string" ? record.selectedType : typeof record.typeName === "string" ? record.typeName : "Denúncia" },
      { name: "Denunciante", value: record.anonymous === true ? "Denúncia anônima" : typeof record.requesterId === "string" ? `<@${record.requesterId}> | ${record.requesterId}` : typeof record.authorId === "string" ? `<@${record.authorId}> | ${record.authorId}` : null },
      { name: "Detalhes", value: formatPoliceReportDetails(record) }
    ],
    image: config.channelVisual ?? config.panelVisual,
    title: "Denúncia"
  });
}

function formatPoliceReportDetails(record: Record<string, unknown>) {
  const ignored = new Set(["anonymous", "authorId", "channelId", "requesterId", "selectedType", "typeName"]);
  const lines = Object.entries(record)
    .filter(([key, value]) => !ignored.has(key) && value !== null && value !== undefined && value !== "")
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  return lines.length ? lines.join("\n") : "-";
}
function scheduleChannelExpiry(channelId: string, guildId: string, minutes: number, context: BotContext) {
  const delay = Math.min(Math.max(1, minutes) * 60_000, 2_147_000_000);
  setTimeout(() => {
    const guild = context.client.guilds.cache.get(guildId);
    void guild?.channels.fetch(channelId).then(async (channel) => {
      if (!channel || !("delete" in channel)) return;
      await channel.delete("Denuncia IAB expirada por tempo maximo").catch(() => null);
      await writeLog(context, guildId, null, "police-reports.channel_deleted", "Canal temporario deletado por tempo maximo.", { channelId, maxChannelMinutes: minutes });
    }).catch(() => null);
  }, delay).unref?.();
}
