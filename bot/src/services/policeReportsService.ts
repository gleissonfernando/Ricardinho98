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
import { currentRuntimeBotId, isBotModuleEnabled, setRuntimeEnabledModules } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import { renderComponentsV2Panel, resolvePanelImageUrl } from "./panelVisualRenderer";
import type { PanelVisualConfig, PanelVisualPosition } from "./panelVisualRenderer";
import { sendPoliceLog } from "./policeLogService";

const MODULE_ID = "police-reports";
const PREFIX = "police_reports";
const PAGE_SIZE = 25;
const DEV_USER_IDS = new Set(["1426287249020158018"]);
const IAB_WEBHOOK_NAME = "Human Resources - NPD";
const PANEL_TITLE = "Denúncia IAB";
const BUTTON_LABEL = "Abrir denuncia";
const PANEL_HELP_TEXT = [
  "**Como funciona**",
  "1. Selecione no menu abaixo o tipo que melhor descreve a denuncia.",
  "2. Escolha se a denuncia sera **identificada** ou **anonima**. Na anonima, a equipe nao ve seu usuario no painel de analise.",
  "3. O bot cria um canal privado temporario apenas para voce preparar o procedimento.",
  "4. Envie prints, videos, links, IDs, nomes envolvidos, datas, horarios e uma descricao completa do ocorrido.",
  "5. Revise os arquivos e aguarde todos os uploads terminarem antes de confirmar.",
  "6. Clique em **Confirmar envio da denuncia**. Depois disso, seu acesso ao canal e removido e a Corregedoria recebe o ticket para analise.",
  "7. Se a equipe precisar de mais informacoes, ela pode devolver seu acesso ao canal pelo proprio painel."
].join("\n");
const IAB_EMOJI = {
  alert: "🔔",
  anonymous: "🎭",
  archive: "🗄️",
  assume: "🙋",
  identified: "🪪",
  next: "➡️",
  previous: "⬅️",
  submit: "📨",
  submitCancel: "↩️",
  submitConfirm: "✅",
  validate: "🛡️",
  finish: "🔒"
} as const;
const PROCEDURE_ACTIONS = ["submit", "submit_confirm", "submit_cancel", "assume", "accept", "approve", "validate", "alert", "ping", "request_info", "finish", "archive", "transcript", "close"] as const;

type ComplaintType = { id: string; name: string; description: string | null; emoji: string | null; order: number };
type PoliceReportsConfig = {
  enabled: boolean;
  allowAnonymous: boolean;
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
  highCommandCategoryId: string | null;
  highCommandRoleIds: string[];
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
type PoliceReportStatus = "draft" | "submitted" | "accepted" | "validated" | "finished" | "archived";
type PoliceReportTopic = {
  anonymous: boolean;
  selectedId: string;
  expiresAt: number | null;
  requesterId: string | null;
  status: PoliceReportStatus;
  panelMessageId: string | null;
  submittedAt: number | null;
  acceptedBy: string | null;
  acceptedAt: number | null;
  closedAt: number | null;
};

const REPORT_STATUS_LABELS: Record<PoliceReportStatus, string> = {
  accepted: "Em atendimento",
  archived: "Arquivada",
  draft: "Aguardando provas",
  finished: "Finalizada",
  submitted: "Enviada para análise",
  validated: "Validada"
};

const DEFAULT_COMPLAINT_TYPES: ComplaintType[] = [
  { id: "denuncia-oficiais", name: "Denúncia de Oficiais", description: "Relatar conduta inadequada de oficiais.", emoji: "🛡️", order: 1 },
  { id: "denuncia-alto-comando", name: "Denúncia de Alto Comando", description: "Relatar ocorrencias envolvendo alto comando.", emoji: "⭐", order: 2 },
  { id: "corregedoria", name: "Corregedoria", description: "Encaminhamento direto para a corregedoria.", emoji: "⚖️", order: 3 },
  { id: "ouvidoria", name: "Ouvidoria", description: "Enviar manifestacoes, duvidas ou solicitacoes.", emoji: "📣", order: 4 },
  { id: "abuso-de-poder", name: "Abuso de Poder", description: "Denunciar abuso de autoridade ou uso indevido do cargo.", emoji: "🚨", order: 5 },
  { id: "assuntos-internos", name: "Assuntos Internos", description: "Abrir procedimento sigiloso de assuntos internos.", emoji: "🔎", order: 6 }
];
const imageHealthCache = new Map<string, { expiresAt: number; ok: boolean }>();
const configCache = new Map<string, { config: PoliceReportsConfig; expiresAt: number }>();

function mergeDefaultComplaintTypes(types: ComplaintType[]) {
  const normalizedName = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const officialAliases = new Set(["denuncia de oficial", "denuncia de oficiais"]);
  const matched = new Set<string>();
  const required = DEFAULT_COMPLAINT_TYPES.map((fallback) => {
    const existing = types.find((item) => item.id === fallback.id || normalizedName(item.name) === normalizedName(fallback.name) || (fallback.id === "denuncia-oficiais" && officialAliases.has(normalizedName(item.name))));
    if (existing) matched.add(existing.id);
    return existing ? { ...existing, id: fallback.id, name: fallback.name, emoji: fallback.emoji, order: fallback.order } : fallback;
  });
  return [...required, ...types.filter((item) => !matched.has(item.id)).map((item, index) => ({ ...item, order: required.length + index + 1 }))];
}

function isHighCommandComplaint(type: Pick<ComplaintType, "id" | "name">) {
  const normalized = type.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return type.id === "denuncia-alto-comando"
    || normalized.includes("alto comando")
    || normalized.includes("high command")
    || normalized.includes("hcmd");
}

function reviewerRoleIdsFor(config: PoliceReportsConfig, selected: Pick<ComplaintType, "id" | "name">) {
  return isHighCommandComplaint(selected)
    ? uniqueIds(config.highCommandRoleIds)
    : uniqueIds(config.responsibleRoleIds.length ? config.responsibleRoleIds : [config.responsibleRoleId].filter(Boolean) as string[]);
}

function mentionRoleIdsFor(config: PoliceReportsConfig, selected: Pick<ComplaintType, "id" | "name">) {
  const roleId = isHighCommandComplaint(selected)
    ? config.highCommandRoleIds[0]
    : config.responsibleRoleId ?? config.responsibleRoleIds[0];
  return roleId ? [roleId] : [];
}

export const policeReportsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("config_denuncias")
    .setDescription("Gerencia o painel de denuncias IAB.")
    .addSubcommand((command) => command.setName("publicar").setDescription("Publica ou atualiza o painel configurado.")),
  moduleId: MODULE_ID,
  async execute(interaction, context) {
    if (!interaction.guild || (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !isPoliceReportsDev(interaction.user.id))) {
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
    clearPoliceReportsConfigCache(payload.guildId);
    const guild = client.guilds.cache.get(payload.guildId);
    if (guild) void publishPoliceReportsPanel(guild, context, payload.action === "publish").catch((error) => {
      console.warn("[police-reports] falha ao atualizar painel:", error instanceof Error ? error.message : error);
    });
  });
  setTimeout(() => {
    for (const guild of client.guilds.cache.values()) {
      void publishPoliceReportsPanel(guild, context, false).catch((error) => {
        console.warn(`[police-reports] painel existente nao foi sincronizado em ${guild.id}:`, error instanceof Error ? error.message : error);
      });
      void restoreOpenPoliceReportChannels(guild, context).catch((error) => {
        console.warn(`[police-reports] tickets abertos nao foram restaurados em ${guild.id}:`, error instanceof Error ? error.message : error);
      });
    }
  }, 5_000).unref?.();
}

export async function handlePoliceReportsInteraction(interaction: Interaction, context: BotContext) {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guild) {
    await interaction.reply({ content: "Use este painel dentro de um servidor.", ephemeral: true }).catch(() => undefined);
    return true;
  }
  if (!isBotModuleEnabled(MODULE_ID)) {
    const restored = await refreshPoliceReportsRuntimeModules(context);
    if (!restored && !isExistingPoliceReportTicketInteraction(interaction)) {
      await interaction.reply({ content: "A Denúncia IAB não está liberada para este bot.", ephemeral: true }).catch(() => undefined);
      return true;
    }
  }
  if (interaction.isStringSelectMenu()) {
    await ensureEphemeralReply(interaction);
    const config = await loadConfig(interaction.guild.id, context, false);
    if (!config) {
      await respondEphemeral(interaction, "A configuracao deste painel nao esta disponivel.");
      return true;
    }
    const selected = config.complaintTypes.find((item) => item.id === interaction.values[0]);
    if (!selected) {
      await respondEphemeral(interaction, "Este tipo de denuncia nao esta mais disponivel.");
      return true;
    }
    const page = Math.max(0, Number(interaction.customId.split(":")[2] ?? 0) || 0);
    if (!config.allowAnonymous) {
      await createTemporaryProcedureChannel(interaction, context, config, selected, false);
      return true;
    }
    await interaction.message.edit(createPanelPayload(config, page)).catch(() => undefined);
    await showIdentitySelection(interaction, selected);
    return true;
  }
  const action = normalizePoliceReportsAction(interaction.customId.split(":")[1]);
  if (action === "page") {
    await interaction.deferUpdate();
    const config = await loadConfig(interaction.guild.id, context, false);
    if (config) {
      const page = Math.max(0, Number(interaction.customId.split(":")[2] ?? 0) || 0);
      await interaction.message.edit(createPanelPayload(config, page)).catch(() => undefined);
    }
    return true;
  }
  const shouldPreAck = action === "identity";
  if (shouldPreAck) {
    await ensureEphemeralReply(interaction);
  }
  if (interaction.isButton() && isProcedureAction(action)) {
    if (action === "submit_cancel") {
      await interaction.update({ components: [], content: "Envio cancelado. O ticket continua aberto para você enviar provas." }).catch(() => undefined);
      return true;
    }
    await acknowledgeProcedureAction(interaction, action);
  }
  const config = await loadConfig(interaction.guild.id, context, false).catch(async (error) => {
    console.warn("[police-reports] falha ao carregar configuracao para interacao:", error instanceof Error ? error.message : error);
    if (interaction.isButton() && isProcedureAction(action)) {
      await respondProcedure(interaction, "Nao foi possivel carregar a configuracao da Denuncia IAB agora. Tente novamente em alguns segundos.");
    }
    return null;
  });
  if (!config) {
    if (interaction.isButton() && isProcedureAction(action)) {
      return true;
    }
    await respondEphemeral(interaction, "A configuracao deste painel nao esta disponivel.");
    return true;
  }
  if (action === "identity") {
    const [, , mode, selectedId] = interaction.customId.split(":");
    const selected = config.complaintTypes.find((item) => item.id === selectedId);
    if (!selected || (mode !== "anonymous" && mode !== "identified")) {
      await respondEphemeral(interaction, "Esta opcao de denuncia nao esta mais disponivel.");
      return true;
    }
    await createTemporaryProcedureChannel(interaction, context, config, selected, mode === "anonymous");
    return true;
  }
  if (isProcedureAction(action)) {
    await handleProcedureAction(interaction, context, config, action!);
    return true;
  }
  await interaction.reply({ content: "Esta ação da Denúncia IAB não é mais válida. Publique o painel novamente.", ephemeral: true });
  return true;
}

async function showIdentitySelection(interaction: StringSelectMenuInteraction, selected: ComplaintType) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:identity:identified:${selected.id}`).setLabel("Denuncia Identificada").setEmoji(IAB_EMOJI.identified).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:identity:anonymous:${selected.id}`).setLabel("Denuncia Anonima").setEmoji(IAB_EMOJI.anonymous).setStyle(ButtonStyle.Secondary)
  );
  await respondEphemeral(interaction, {
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

type PoliceReportsComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

async function ensureEphemeralReply(interaction: PoliceReportsComponentInteraction) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

async function respondEphemeral(interaction: PoliceReportsComponentInteraction, payload: string | Record<string, unknown>) {
  const body = typeof payload === "string"
    ? { content: payload, flags: MessageFlags.Ephemeral }
    : { flags: MessageFlags.Ephemeral, ...payload };

  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(body as never).catch(() => undefined);
    return;
  }

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(body as never).catch(() => undefined);
    return;
  }

  await interaction.reply(body as never).catch(() => undefined);
}

async function refreshPoliceReportsRuntimeModules(context: BotContext) {
  const runtime = await context.api.getRuntimeModules().catch((error) => {
    console.warn("[police-reports] nao foi possivel recarregar modulos antes da interacao:", error instanceof Error ? error.message : error);
    return null;
  });

  if (!runtime) {
    return false;
  }

  setRuntimeEnabledModules(runtime.active ? runtime.enabledModules : [], runtime.botId);
  return isBotModuleEnabled(MODULE_ID);
}

function isExistingPoliceReportTicketInteraction(interaction: Interaction) {
  if (!interaction.isButton()) {
    return false;
  }

  const channel = interaction.channel;
  if (!channel || !("topic" in channel)) {
    return false;
  }

  const action = normalizePoliceReportsAction(interaction.customId.split(":")[1]);
  if (!isProcedureAction(action)) {
    return false;
  }

  return Boolean(parsePoliceReportTopic(String(channel.topic ?? "")));
}

function isProcedureAction(action: string | undefined): action is typeof PROCEDURE_ACTIONS[number] {
  return PROCEDURE_ACTIONS.includes(action as typeof PROCEDURE_ACTIONS[number]);
}

function clearPoliceReportsConfigCache(guildId: string) {
  for (const key of configCache.keys()) {
    if (key.includes(`:${guildId}:`)) {
      configCache.delete(key);
    }
  }
}

async function acknowledgeProcedureAction(interaction: ButtonInteraction, action: string) {
  if (interaction.deferred || interaction.replied) return;

  if (action === "submit_confirm") {
    await interaction.update({ components: [], content: "Enviando denúncia para análise..." }).catch(() => undefined);
    return;
  }

  await interaction.deferReply({ ephemeral: action === "request_info" || action === "ping" ? false : true }).catch(() => undefined);
}

async function respondProcedure(interaction: ButtonInteraction, payload: string | Parameters<ButtonInteraction["reply"]>[0]) {
  const body = typeof payload === "string" ? { content: payload, ephemeral: true } : payload;

  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(body as never).catch(() => undefined);
    return;
  }

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(body as never).catch(() => undefined);
    return;
  }

  await interaction.reply(body as never).catch(() => undefined);
}

async function restoreOpenPoliceReportChannels(guild: Guild, context: BotContext) {
  const now = Date.now();
  const channels = guild.channels.cache.filter((channel) => "topic" in channel && Boolean(parsePoliceReportTopic(String(channel.topic ?? ""))));

  for (const channel of channels.values()) {
    const topic = parsePoliceReportTopic(String(("topic" in channel ? channel.topic : "") ?? ""));
    if (!topic || topic.status === "finished" || topic.status === "archived" || !topic.expiresAt || topic.expiresAt <= now) {
      continue;
    }

    const remainingMinutes = Math.max(1, Math.ceil((topic.expiresAt - now) / 60_000));
    scheduleChannelExpiry(channel.id, guild.id, remainingMinutes, context);
  }
}

async function publishPoliceReportsPanel(guild: Guild, context: BotContext, allowCreate: boolean) {
  const config = await loadConfig(guild.id, context);
  if (!config?.enabled) throw new Error("Ative a Denúncia IAB antes de publicar.");
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

async function loadConfig(guildId: string, context: BotContext, sanitizeImages = true): Promise<PoliceReportsConfig | null> {
  const botId = currentRuntimeBotId();
  if (!botId) return null;
  const cacheKey = `${botId}:${guildId}:${sanitizeImages ? "visual" : "runtime"}`;
  const cached = configCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const runtime = await context.api.getBotGuildConfig(botId, guildId);
  const [mainVisual, channelVisual, footerVisual] = sanitizeImages
    ? await Promise.all([
      context.api.getPanelVisualSettings(guildId, "police-reports").catch(() => null),
      context.api.getPanelVisualSettings(guildId, "police-reports-banner-2").catch(() => null),
      context.api.getPanelVisualSettings(guildId, "police-reports-banner-3").catch(() => null)
    ])
    : [null, null, null];
  const raw = runtime.modules[MODULE_ID] ?? {};
  const complaintTypes = Array.isArray(raw.complaintTypes)
    ? raw.complaintTypes.filter(isComplaintType).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    : [];
  const config: PoliceReportsConfig = {
    enabled: raw.enabled === true,
    panelChannelId: readString(raw.panelChannelId),
    panelChannelIds: idList(raw.panelChannelIds, readString(raw.panelChannelId)),
    panelMessageId: readString(raw.panelMessageId),
    allowAnonymous: raw.allowAnonymous !== false,
    panelTitle: normalizePanelTitle(readString(raw.panelTitle)),
    panelDescription: readString(raw.panelDescription) ?? "Registre uma denuncia de forma segura e sigilosa.",
    buttonLabel: normalizeButtonLabel(readString(raw.buttonLabel)),
    color: readString(raw.color) ?? "#7c3aed",
    thumbnailUrl: readString(raw.thumbnailUrl) ?? "",
    categoryId: readString(raw.categoryId),
    categoryIds: idList(raw.categoryIds, readString(raw.categoryId)),
    highCommandCategoryId: readString(raw.highCommandCategoryId),
    highCommandRoleIds: readStringArray(raw.highCommandRoleIds),
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
  const resolved = sanitizeImages ? await sanitizePoliceReportImages(config) : config;
  configCache.set(cacheKey, { config: resolved, expiresAt: Date.now() + (sanitizeImages ? 60_000 : 10_000) });
  return resolved;
}

async function sanitizePoliceReportImages(config: PoliceReportsConfig): Promise<PoliceReportsConfig> {
  const [panelVisual, channelVisual, footerVisual] = await Promise.all([
    healthyVisual(config.panelVisual),
    healthyVisual(config.channelVisual),
    healthyVisual(config.footerVisual)
  ]);

  return {
    ...config,
    channelVisual,
    footerVisual,
    panelVisual
  };
}

async function healthyVisual(visual: PanelVisualConfig | null): Promise<PanelVisualConfig | null> {
  if (!visual?.imageEnabled || !visual.imageUrl || visual.imagePosition === "none") return null;
  const resolved = resolvePanelImageUrl(visual.imageUrl);
  if (!resolved) return null;
  if (!await isReachableImageUrl(resolved)) return null;
  return { ...visual, imageUrl: resolved };
}

async function isReachableImageUrl(url: string) {
  const cached = imageHealthCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;

  const ok = await probeImageUrl(url);
  imageHealthCache.set(url, { expiresAt: Date.now() + 5 * 60_000, ok });
  return ok;
}

async function probeImageUrl(url: string) {
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(700) });
    if (head.ok && isImageContentType(head.headers.get("content-type"))) return true;
    if (head.status !== 405 && head.status !== 403) return false;
  } catch {
    // Some image hosts reject HEAD; try a tiny GET before dropping the image.
  }

  try {
    const get = await fetch(url, { headers: { Range: "bytes=0-0" }, method: "GET", signal: AbortSignal.timeout(900) });
    return get.ok && isImageContentType(get.headers.get("content-type"));
  } catch {
    return false;
  }
}

function isImageContentType(value: string | null) {
  return /^image\/(png|jpe?g|gif|webp)/i.test(value ?? "");
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
      new ButtonBuilder().setCustomId(`${PREFIX}:page:${Math.max(0, page - 1)}`).setEmoji(IAB_EMOJI.previous).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`${PREFIX}:page:${Math.min(pageCount - 1, page + 1)}`).setEmoji(IAB_EMOJI.next).setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1)
    ));
  }
  return renderComponentsV2Panel({
    accentColor: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    actions,
    description: `${config.panelDescription}${pageCount > 1 ? `\n\nPagina ${page + 1} de ${pageCount}` : ""}`,
    fields: [PANEL_HELP_TEXT],
    footerIcon: config.footerVisual,
    footerText: `**NPD - IAB** · Selecione o tipo abaixo · <t:${Math.floor(Date.now() / 1000)}:f>`,
    headerText: "**North Police Department - Corregedoria**",
    image: config.panelVisual,
    moduleId: MODULE_ID,
    title: config.panelTitle
  });
}

async function createTemporaryProcedureChannel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  context: BotContext,
  config: PoliceReportsConfig,
  selected: ComplaintType,
  anonymous: boolean
) {
  if (!interaction.guild) return;
  if (!config.enabled) {
    await respondEphemeral(interaction, "A Denúncia IAB esta desativada.");
    return;
  }
  const highCommandComplaint = isHighCommandComplaint(selected);
  const categoryId = highCommandComplaint ? config.highCommandCategoryId || firstId(config.categoryIds, config.categoryId) : firstId(config.categoryIds, config.categoryId);
  if (!categoryId) {
    await respondEphemeral(interaction, highCommandComplaint ? "O sistema precisa ser configurado na dashboard: selecione a categoria do Alto Comando." : "O sistema precisa ser configurado na dashboard: selecione a categoria dos canais temporarios.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.config_missing", "Categoria temporaria nao configurada.", { selectedType: selected.id });
    return;
  }

  await ensureEphemeralReply(interaction);
  const category = await interaction.guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.editReply("A categoria configurada para denuncias nao foi encontrada.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.channel_create_failed", "Categoria configurada invalida.", { categoryId });
    return;
  }

  const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
  const reviewerRoleIds = reviewerRoleIdsFor(config, selected);
  const devBypass = isPoliceReportsDev(interaction.user.id);
  if (!reviewerRoleIds.length && !devBypass) {
    await interaction.editReply(highCommandComplaint ? "Configure ao menos um cargo do Alto Comando para receber este tipo de denuncia." : "Configure o cargo responsavel pelas denuncias da IAB antes de abrir tickets.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.config_missing", "Cargos do Alto Comando nao configurados.", { selectedType: selected.id });
    return;
  }
  const missingRoles = reviewerRoleIds.filter((roleId) => !interaction.guild!.roles.cache.has(roleId));
  if (missingRoles.length && !devBypass) {
    await interaction.editReply(highCommandComplaint ? "Um ou mais cargos do Alto Comando configurados nao existem mais no servidor." : "Um ou mais cargos responsaveis configurados nao existem mais no servidor.");
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
    const expiresAt = Date.now() + config.maxChannelMinutes * 60_000;
    const initialTopic: PoliceReportTopic = {
      acceptedAt: null,
      acceptedBy: null,
      anonymous,
      closedAt: null,
      expiresAt,
      panelMessageId: null,
      requesterId: interaction.user.id,
      selectedId: selected.id,
      status: "draft",
      submittedAt: null
    };
    const channel = await interaction.guild.channels.create({
      name: safeChannelName(anonymous ? `denuncia-anonima-${interaction.user.id.slice(-4)}` : `denuncia-${interaction.user.username}`),
      parent: category.id,
      topic: serializePoliceReportTopic(initialTopic),
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        ...[...DEV_USER_IDS].filter((userId) => userId !== interaction.user.id).map((userId) => ({ id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] })),
        ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] }] : [])
      ],
      reason: `Denuncia IAB criada por ${interaction.user.tag}`
    });
    const panel = await channel.send(createProcedurePanel(config, selected, initialTopic, interaction.user.id));
    const topicWithPanel = { ...initialTopic, panelMessageId: panel.id };
    await channel.setTopic(serializePoliceReportTopic(topicWithPanel)).catch(() => null);
    await panel.edit(createProcedurePanel(config, selected, topicWithPanel, interaction.user.id)).catch(() => null);
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
  if (!interaction.guild || !interaction.channel || !("topic" in interaction.channel)) {
    await respondProcedure(interaction, "Esta ação precisa ser usada dentro do canal da denúncia.");
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const topic = parsePoliceReportTopic(String(interaction.channel.topic ?? ""));
  if (!topic) {
    await respondProcedure(interaction, "Nao foi possivel identificar os dados desta denuncia. Reabra o painel ou chame a equipe responsavel.");
    return;
  }
  const selected = config.complaintTypes.find((item) => item.id === topic.selectedId) ?? { id: topic.selectedId, name: "Denuncia", description: null, emoji: null, order: 0 };
  const reviewerRoleIds = reviewerRoleIdsFor(config, selected);
  const { anonymous, selectedId } = topic;
  const requesterId = topic.requesterId ?? findRequesterId(interaction.channel, interaction.guild.members.me?.id);
  const devBypass = isPoliceReportsDev(interaction.user.id);
  if (!requesterId) {
    await respondProcedure(interaction, "Nao foi possivel identificar internamente o autor desta denuncia.");
    return;
  }

  if (action === "submit") {
    if (interaction.user.id !== requesterId && !devBypass) {
      await respondProcedure(interaction, "Somente o denunciante pode enviar esta denúncia.");
      return;
    }
    if (topic.status !== "draft") {
      await respondProcedure(interaction, "Essa denúncia já foi enviada para análise.");
      return;
    }
    await respondProcedure(interaction, {
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${PREFIX}:submit_confirm`).setLabel("Confirmar envio").setEmoji(IAB_EMOJI.submitConfirm).setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`${PREFIX}:submit_cancel`).setLabel("Cancelar").setEmoji(IAB_EMOJI.submitCancel).setStyle(ButtonStyle.Secondary)
        )
      ],
      content: "Tem certeza que deseja enviar essa denúncia para análise?\n\nDepois de confirmar, você perderá acesso ao canal e a equipe responsável receberá o ticket.",
      ephemeral: true
    });
    return;
  }

  if (action === "submit_cancel") {
    await respondProcedure(interaction, "Envio cancelado. O ticket continua aberto para você enviar provas.");
    return;
  }

  if (action === "submit_confirm") {
    if (interaction.user.id !== requesterId && !devBypass) {
      await respondProcedure(interaction, "Somente o denunciante pode confirmar o envio.");
      return;
    }
    if (topic.status !== "draft") {
      await respondProcedure(interaction, "Essa denúncia já foi enviada.");
      return;
    }
    try {
      await submitPoliceReport(interaction, context, config, selected, topic, requesterId, reviewerRoleIds, mentionRoleIdsFor(config, selected));
      await interaction.followUp({ content: "Denúncia enviada para análise. Você não verá mais este canal.", ephemeral: true }).catch(() => null);
    } catch (error) {
      await interaction.followUp({ content: "Nao foi possivel enviar esta denuncia agora. A equipe foi avisada nos logs.", ephemeral: true }).catch(() => null);
      await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.submit_failed", "Falha ao confirmar envio da denuncia.", {
        channelId: interaction.channel.id,
        error: error instanceof Error ? error.message : String(error),
        requesterId,
        selectedType: selected.name
      });
    }
    return;
  }

  const isAdmin = Boolean(member?.permissions.has(PermissionFlagsBits.Administrator));
  const allowed = Boolean(devBypass || isAdmin || reviewerRoleIds.some((roleId) => member?.roles.cache.has(roleId)));
  if (!allowed) {
    await respondProcedure(interaction, isHighCommandComplaint(selected) ? "Apenas o Alto Comando configurado pode executar esta acao." : "Apenas responsaveis configurados podem executar esta acao.");
    return;
  }
  if (topic.status === "draft") {
    await respondProcedure(interaction, "A equipe só pode usar estes botões depois que o denunciante confirmar o envio.");
    return;
  }
  if (topic.status === "finished") {
    await respondProcedure(interaction, "Este ticket já foi finalizado.");
    return;
  }
  if (topic.status === "archived" && action !== "finish" && action !== "close") {
    await respondProcedure(interaction, "Este ticket está arquivado. Apenas a finalização definitiva ainda está disponível.");
    return;
  }
  const restrictedToAssignee = ["approve", "validate", "alert", "ping", "request_info", "finish", "archive", "close"].includes(action);
  if (restrictedToAssignee && topic.acceptedBy && topic.acceptedBy !== interaction.user.id && !isAdmin && !devBypass) {
    await respondProcedure(interaction, "Este ticket já foi assumido por outro membro da equipe. Apenas o responsável pode executar esta ação.");
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.action_denied", "Tentativa de acao por membro que nao assumiu o ticket.", { action, acceptedBy: topic.acceptedBy, channelId: interaction.channel.id });
    return;
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: action === "request_info" || action === "ping" ? false : true });
  }

  if (action === "assume" || action === "accept") {
    if (topic.acceptedBy && topic.acceptedBy !== interaction.user.id) {
      await interaction.editReply(`Essa denúncia já está sendo atendida por <@${topic.acceptedBy}>.`);
      return;
    }
    const next = { ...topic, acceptedAt: topic.acceptedAt ?? Date.now(), acceptedBy: interaction.user.id, status: "accepted" as const };
    await setPoliceReportTopic(interaction.channel, next);
    await updateProcedurePanel(interaction, config, selected, next, requesterId);
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.accepted", "Denúncia aceita pela equipe IAB.", {
      acceptedBy: interaction.user.id,
      anonymous,
      channelId: interaction.channel.id,
      requesterId,
      typeName: selected.name
    });
    await interaction.editReply("Denúncia aceita. O painel foi atualizado.");
    return;
  }

  if (action === "approve" || action === "validate") {
    if (!topic.acceptedBy && !isAdmin) {
      await interaction.editReply("Assuma o ticket antes de validar a denúncia.");
      return;
    }
    const next = { ...topic, acceptedAt: topic.acceptedAt ?? Date.now(), acceptedBy: topic.acceptedBy ?? interaction.user.id, status: "validated" as const };
    await setPoliceReportTopic(interaction.channel, next);
    await updateProcedurePanel(interaction, config, selected, next, requesterId);
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.validated", "Denúncia validada pela equipe IAB.", { anonymous, channelId: interaction.channel.id, requesterId, typeName: selected.name, validatedBy: interaction.user.id });
    await interaction.editReply("Denúncia validada. O painel foi atualizado.");
    return;
  }

  if (action === "alert" || action === "ping" || action === "request_info") {
    if ("permissionOverwrites" in interaction.channel) {
      await interaction.channel.permissionOverwrites.edit(requesterId, {
        AttachFiles: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ViewChannel: true
      }, { reason: `Denunciante chamado de volta por ${interaction.user.tag}` }).catch(async (error) => {
        await writeLog(context, interaction.guild!.id, interaction.user.id, "police-reports.alert_access_failed", "Erro ao devolver acesso ao denunciante.", { channelId: interaction.channel!.id, error: error instanceof Error ? error.message : String(error), requesterId });
      });
    }
    const dmText = anonymous
      ? "🔔 A equipe IAB solicitou sua atencao em uma denuncia anonima.\n\nVoce pode responder normalmente pelo canal do ticket. Sua identidade continuara oculta."
      : `🔔 A equipe IAB solicitou mais informações sobre uma denúncia.\n\nResponda a equipe conforme as orientações recebidas.`;
    const user = await interaction.client.users.fetch(requesterId).catch(() => null);
    const dmSent = Boolean(await user?.send({ allowedMentions: { parse: [] }, content: dmText }).then(() => true).catch(() => false));
    if ("send" in interaction.channel) {
      await interaction.channel.send({
        allowedMentions: anonymous ? { parse: [] } : { users: [requesterId] },
        content: anonymous
          ? "🔔 A equipe IAB solicitou novas informações ao denunciante anônimo. O acesso foi liberado para resposta."
          : `<@${requesterId}> a equipe IAB solicitou novas informações. Envie as provas ou respostas necessárias neste canal.`
      }).catch(() => null);
    }
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.requester_alerted", "Denunciante chamado de volta ao canal.", { anonymous, channelId: interaction.channel.id, requesterId, requestedBy: interaction.user.id, typeName: selected.name });
    await interaction.editReply({
      content: anonymous
        ? `🔔 O denunciante anonimo voltou a ter acesso ao canal.${dmSent ? "" : "\nNao foi possivel entregar a DM; o privado pode estar fechado."}`
        : `🔔 O denunciante voltou a ter acesso ao canal.${dmSent ? "" : "\nNao foi possivel entregar a DM; o privado pode estar fechado."}`,
      allowedMentions: { parse: [] }
    });
    return;
  }

  if (action === "transcript") {
    const logChannelId = firstId(config.logChannelIds, config.logChannelId);
    const target = logChannelId
      ? await interaction.guild.channels.fetch(logChannelId).catch(() => null)
      : interaction.channel;
    const payload = await createArchivePanel(config, selected, requesterId, anonymous, interaction.channel, Boolean(logChannelId && target));
    if (target && "send" in target && !target.isDMBased()) {
      await target.send(payload).catch(async (error) => {
        await writeLog(context, interaction.guild!.id, interaction.user.id, "police-reports.archive_failed", "Falha ao enviar transcript da denúncia.", { channelId: interaction.channel!.id, error: error instanceof Error ? error.message : String(error) });
      });
    }
    await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.transcript", "Transcript de denúncia gerado.", { channelId: interaction.channel.id, requesterId, anonymous, typeName: selected.name });
    await interaction.editReply("Transcript enviado para o canal de logs configurado.");
    return;
  }

  if (action === "finish" || action === "close" || action === "archive") {
    const archiveCategoryId = firstId(config.archiveCategoryIds, config.archiveCategoryId);
    if (!archiveCategoryId) {
      await interaction.editReply("Configure a categoria de denuncias finalizadas na dashboard antes de finalizar.");
      await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.finish_failed", "Categoria de finalizacao nao configurada.", { channelId: interaction.channel.id });
      return;
    }
    const archiveCategory = await interaction.guild.channels.fetch(archiveCategoryId).catch(() => null);
    if (!archiveCategory || archiveCategory.type !== ChannelType.GuildCategory || !("setParent" in interaction.channel)) {
      await interaction.editReply("A categoria de finalizacao configurada nao foi encontrada ou o canal nao pode ser movido.");
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
    for (const roleId of reviewerRoleIds) {
      await interaction.channel.permissionOverwrites.edit(roleId, {
        SendMessages: false,
        ViewChannel: true
      }, { reason: `Denuncia IAB finalizada por ${interaction.user.tag}` }).catch(() => null);
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
    const next = { ...topic, closedAt: Date.now(), status: action === "archive" ? "archived" as const : "finished" as const };
    await setPoliceReportTopic(interaction.channel, next);
    await updateProcedurePanel(interaction, config, selected, next, requesterId);
    const logChannelId = firstId(config.logChannelIds, config.logChannelId);
    const target = logChannelId
      ? await interaction.guild.channels.fetch(logChannelId).catch(() => null)
      : interaction.channel;
    const payload = await createArchivePanel(config, selected, requesterId, anonymous, interaction.channel, Boolean(logChannelId && target));
    if (target && "send" in target && !target.isDMBased()) await target.send(payload).catch(() => null);
    await interaction.editReply(action === "archive" ? "Denúncia arquivada. Transcript enviado aos logs privados." : "Denúncia finalizada. Transcript enviado aos logs privados.");
    return;
  }

  await interaction.editReply("Ação da denúncia inválida ou expirada. Publique o painel novamente se necessário.");
}

function createProcedurePanel(config: PoliceReportsConfig, selected: ComplaintType, topic: PoliceReportTopic, userId: string, mentionRoleIds: string[] = [], notifyMention = false) {
  const createdAt = Math.floor(((topic.expiresAt ?? Date.now()) - config.maxChannelMinutes * 60_000) / 1000);
  const submittedAt = topic.submittedAt ? Math.floor(topic.submittedAt / 1000) : null;
  const acceptedAt = topic.acceptedAt ? Math.floor(topic.acceptedAt / 1000) : null;
  const closedAt = topic.closedAt ? Math.floor(topic.closedAt / 1000) : null;
  const finished = topic.status === "finished";
  const archived = topic.status === "archived";
  const interactionLocked = finished || archived;
  const topMention = topic.status === "draft" || !mentionRoleIds.length
    ? null
    : `**Equipe responsável:** ${mentionRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")}`;
  const actions = topic.status === "draft"
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:submit`).setLabel("Confirmar envio da denúncia").setEmoji(IAB_EMOJI.submit).setStyle(ButtonStyle.Danger)
    )]
    : [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:assume`).setLabel("Assumir Ticket").setEmoji(IAB_EMOJI.assume).setStyle(ButtonStyle.Success).setDisabled(interactionLocked || Boolean(topic.acceptedBy)),
      new ButtonBuilder().setCustomId(`${PREFIX}:approve`).setLabel("Validar denúncia").setEmoji(IAB_EMOJI.validate).setStyle(ButtonStyle.Primary).setDisabled(interactionLocked || topic.status === "validated"),
      new ButtonBuilder().setCustomId(`${PREFIX}:alert`).setLabel("Alertar denunciante").setEmoji(IAB_EMOJI.alert).setStyle(ButtonStyle.Secondary).setDisabled(interactionLocked),
      new ButtonBuilder().setCustomId(`${PREFIX}:archive`).setLabel("Arquivar").setEmoji(IAB_EMOJI.archive).setStyle(ButtonStyle.Secondary).setDisabled(interactionLocked),
      new ButtonBuilder().setCustomId(`${PREFIX}:finish`).setLabel("Finalizar").setEmoji(IAB_EMOJI.finish).setStyle(ButtonStyle.Danger).setDisabled(finished)
    )];
  const payload = renderComponentsV2Panel({
    accentColor: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    actions,
    description: topic.status === "draft"
      ? "Antes de enviar sua denúncia para análise, envie todas as provas neste canal.\n\n✅ Envie prints, vídeos, links e descrições completas.\n✅ Verifique se os arquivos não estão corrompidos.\n✅ Aguarde o upload terminar antes de confirmar.\n✅ Não apague mensagens após enviar.\n✅ Explique o ocorrido com o máximo de detalhes possível.\n\nQuando tudo estiver pronto, clique no botão abaixo para encaminhar a denúncia.\n\nApós o envio, você não verá mais este canal. A equipe responsável receberá o ticket e dará continuidade ao procedimento."
      : config.initialMessage,
    fields: [
      [
        `**Usuário:** ${topic.anonymous ? "Denúncia anônima" : `<@${userId}>`}`,
        `**Sistema:** ${PANEL_TITLE}`,
        `**Tipo:** ${selected.name}`,
        `**Status:** ${REPORT_STATUS_LABELS[topic.status]}`,
        `**Canal:** ${topic.panelMessageId ? "registrado" : "aguardando registro"}`,
        `**Responsável:** ${topic.acceptedBy ? `<@${topic.acceptedBy}>` : "Nenhum"}`,
        `**Data de abertura:** <t:${createdAt}:F>`,
        `**Data de envio:** ${submittedAt ? `<t:${submittedAt}:F>` : "Ainda não enviada"}`,
        `**Data de aceite:** ${acceptedAt ? `<t:${acceptedAt}:F>` : "Ainda não aceita"}`,
        `**Data de finalização:** ${closedAt ? `<t:${closedAt}:F>` : "Ainda não finalizada"}`,
        `**ID do registro:** ${topic.panelMessageId ?? "pendente"}`
      ].join("\n"),
      config.procedureText
    ],
    image: config.channelVisual ?? config.panelVisual,
    footerIcon: config.footerVisual,
    footerText: `**NPD - IAB** · Procedimento aberto · <t:${createdAt}:f>`,
    headerText: topMention ?? undefined,
    moduleId: MODULE_ID,
    title: topic.status === "draft" ? "Central de Denúncias — IAB" : "Registro de Denúncia"
  });
  return notifyMention && mentionRoleIds.length ? { ...payload, allowedMentions: { roles: mentionRoleIds } } : payload;
}

async function submitPoliceReport(
  interaction: ButtonInteraction,
  context: BotContext,
  config: PoliceReportsConfig,
  selected: ComplaintType,
  topic: PoliceReportTopic,
  requesterId: string,
  reviewerRoleIds: string[],
  mentionRoleIds: string[]
) {
  if (!interaction.guild || !interaction.channel || !("permissionOverwrites" in interaction.channel)) return;
  const channel: any = interaction.channel;
  const submittedAt = Date.now();
  const next: PoliceReportTopic = { ...topic, status: "submitted", submittedAt };

  if (!isPoliceReportsDev(requesterId)) {
    await channel.permissionOverwrites.edit(requesterId, {
      SendMessages: false,
      ViewChannel: false
    }, { reason: `Denuncia IAB enviada por ${interaction.user.tag}` }).catch(async (error: unknown) => {
      await writeLog(context, interaction.guild!.id, interaction.user.id, "police-reports.requester_remove_failed", "Erro ao remover denunciante após envio.", { channelId: channel.id, error: error instanceof Error ? error.message : String(error), requesterId });
    });
  }

  for (const devUserId of DEV_USER_IDS) {
    await channel.permissionOverwrites.edit(devUserId, {
      AttachFiles: true,
      ReadMessageHistory: true,
      SendMessages: true,
      ViewChannel: true
    }, { reason: `Acesso DEV ao fluxo IAB enviado por ${interaction.user.tag}` }).catch(() => null);
  }

  for (const roleId of reviewerRoleIds) {
    await channel.permissionOverwrites.edit(roleId, {
      AttachFiles: true,
      ReadMessageHistory: true,
      SendMessages: true,
      ViewChannel: true
    }, { reason: `Denuncia IAB enviada por ${interaction.user.tag}` }).catch(async (error: unknown) => {
      await writeLog(context, interaction.guild!.id, interaction.user.id, "police-reports.reviewer_add_failed", "Erro ao adicionar equipe à denúncia enviada.", { channelId: channel.id, error: error instanceof Error ? error.message : String(error), roleId });
    });
  }

  await setPoliceReportTopic(channel, next);
  await updateProcedurePanel(interaction, config, selected, next, requesterId, mentionRoleIds, true);
  await writeLog(context, interaction.guild.id, interaction.user.id, "police-reports.submitted", "Denúncia enviada para análise.", {
    anonymous: topic.anonymous,
    channelId: channel.id,
    requesterId,
    mentionedRoleIds: mentionRoleIds,
    reviewerRoleIds,
    submittedAt: new Date(submittedAt).toISOString(),
    typeName: selected.name
  });
}

async function updateProcedurePanel(
  interaction: ButtonInteraction,
  config: PoliceReportsConfig,
  selected: ComplaintType,
  topic: PoliceReportTopic,
  requesterId: string,
  mentionRoleIds: string[] = [],
  notifyMention = false
) {
  if (!interaction.channel || !("messages" in interaction.channel)) return;
  const channel: any = interaction.channel;
  const effectiveMentionRoleIds = mentionRoleIds.length || topic.status === "draft" ? mentionRoleIds : mentionRoleIdsFor(config, selected);
  const payload = createProcedurePanel(config, selected, topic, requesterId, effectiveMentionRoleIds, notifyMention);
  const panel = topic.panelMessageId ? await channel.messages.fetch(topic.panelMessageId).catch(() => null) : null;
  if (panel) {
    await panel.edit(payload).catch(() => null);
    return;
  }
  const message = await channel.send(payload).catch(() => null);
  if (message) {
    await setPoliceReportTopic(channel, { ...topic, panelMessageId: message.id });
  }
}

async function setPoliceReportTopic(channel: unknown, topic: PoliceReportTopic) {
  if (channel && typeof channel === "object" && "setTopic" in channel && typeof (channel as any).setTopic === "function") {
    await (channel as any).setTopic(serializePoliceReportTopic(topic)).catch(() => null);
  }
}

async function createArchivePanel(
  config: PoliceReportsConfig,
  selected: ComplaintType,
  requesterId: string,
  anonymous: boolean,
  channel: ButtonInteraction["channel"],
  revealRequester = false
) {
  const fetched = channel && "messages" in channel
    ? await channel.messages.fetch({ limit: 100 }).catch(() => null)
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
      `**Denunciante**\n${anonymous && !revealRequester ? "Denuncia Anonima" : `${anonymous ? "Denuncia Anonima no ticket\nReal: " : ""}<@${requesterId}> | ${requesterId}`}\n\n**Tipo**\n${selected.name}\n\n**Status**\nARQUIVADO\n\n**Arquivado por**\n${IAB_WEBHOOK_NAME}`,
      `**Data / Horario**\n<t:${createdAt}:F>\n\n**Evidencias**\n${evidence.length ? evidence.join("\n") : "Nenhuma evidencia encontrada no historico recente."}`,
      `**Historico recente**\n${history || "Sem mensagens textuais recentes."}`
    ],
    footerIcon: config.footerVisual,
    footerText: `**NPD - IAB** · denuncia arquivada · <t:${createdAt}:f>`,
    headerText: "**🏛️ North Police Department - IAB**",
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
  if (ticket.status === "draft") return false;
  if (!("send" in message.channel)) return false;
  const requesterId = ticket.requesterId ?? findRequesterId(message.channel, message.guild.members.me?.id);
  const isAuthor = message.author.id === requesterId;
  const isStaff = !isAuthor;
  if (isStaff && ticket.acceptedBy && ticket.acceptedBy !== message.author.id) {
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.delete().catch(() => null);
      await message.channel.send({ allowedMentions: { users: [message.author.id] }, content: `<@${message.author.id}> este ticket já foi assumido por outro responsável. Apenas o responsável pode conduzir o atendimento.` })
        .then((warning) => setTimeout(() => warning.delete().catch(() => null), 8000))
        .catch(() => null);
      await writeLog(context, message.guild.id, message.author.id, "police-reports.message_denied", "Mensagem bloqueada porque o ticket ja foi assumido por outro responsavel.", { acceptedBy: ticket.acceptedBy, channelId: message.channel.id });
      return true;
    }
  }
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
  const [prefix, kind, mode, selectedId, expiresAt, requesterId, status, panelMessageId, submittedAt, acceptedBy, acceptedAt, closedAt] = topic.split("|");
  if (prefix !== PREFIX || kind !== "ticket" || (mode !== "anonymous" && mode !== "identified") || !selectedId) return null;
  return {
    acceptedAt: numberOrNull(acceptedAt),
    acceptedBy: acceptedBy && /^\d{5,32}$/.test(acceptedBy) ? acceptedBy : null,
    anonymous: mode === "anonymous",
    closedAt: numberOrNull(closedAt),
    expiresAt: numberOrNull(expiresAt),
    panelMessageId: panelMessageId && /^\d{5,32}$/.test(panelMessageId) ? panelMessageId : null,
    requesterId: requesterId && /^\d{5,32}$/.test(requesterId) ? requesterId : null,
    selectedId,
    status: parseReportStatus(status),
    submittedAt: numberOrNull(submittedAt)
  };
}

function serializePoliceReportTopic(topic: PoliceReportTopic) {
  return [
    PREFIX,
    "ticket",
    topic.anonymous ? "anonymous" : "identified",
    topic.selectedId,
    topic.expiresAt ?? "",
    topic.requesterId ?? "",
    topic.status,
    topic.panelMessageId ?? "",
    topic.submittedAt ?? "",
    topic.acceptedBy ?? "",
    topic.acceptedAt ?? "",
    topic.closedAt ?? ""
  ].join("|").slice(0, 1024);
}

function parseReportStatus(value: string | undefined): PoliceReportStatus {
  return value === "submitted" || value === "accepted" || value === "validated" || value === "finished" || value === "archived" ? value : "draft";
}

function normalizePoliceReportsAction(action: string | undefined) {
  return action === "ticket" ? "submit" : action;
}

function numberOrNull(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
function normalizePanelTitle(value: string | null) { return !value || value === "Sistema de Denuncias IAB" ? PANEL_TITLE : value; }
function normalizeButtonLabel(value: string | null) { return !value || value === "Selecionar denuncia" ? BUTTON_LABEL : value; }
function readEnabledImageUrl(value: { imageEnabled?: boolean; imageUrl?: string | null } | null) { return value?.imageEnabled && value.imageUrl ? value.imageUrl : null; }
function enabledVisual(value: PanelVisualConfig | null) { return value?.imageEnabled && value.imageUrl ? value : null; }
function readStringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : []; }
function idList(value: unknown, fallback: string | null) { return uniqueIds([...readStringArray(value), ...(fallback ? [fallback] : [])]); }
function firstId(values: string[] | undefined, fallback: string | null | undefined) { return values?.[0] ?? fallback ?? null; }
function readImagePosition(value: unknown): PanelVisualPosition {
  return typeof value === "string" && ["banner", "thumbnail", "top", "below_title", "middle", "bottom", "side", "footer", "before_buttons", "below_text", "above_buttons", "none"].includes(value) ? value as PanelVisualPosition : "banner";
}
function panelImage(imageUrl: string, imagePosition: PanelVisualPosition) { return imageUrl ? { imageEnabled: true, imagePosition, imageUrl } : null; }
function isPoliceReportsDev(userId: string | null | undefined) { return Boolean(userId && DEV_USER_IDS.has(userId)); }
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
      { name: "Sistema", value: PANEL_TITLE },
      { name: "Tipo", value: typeof record.selectedType === "string" ? record.selectedType : typeof record.typeName === "string" ? record.typeName : "Denúncia" },
      { name: "Denunciante", value: policeReportLogRequester(record) },
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

function policeReportLogRequester(record: Record<string, unknown>) {
  const requesterId = typeof record.requesterId === "string"
    ? record.requesterId
    : typeof record.authorId === "string"
      ? record.authorId
      : null;
  if (!requesterId) return record.anonymous === true ? "Denúncia anônima" : null;
  return record.anonymous === true
    ? `Denúncia anônima no ticket\nReal no log: <@${requesterId}> | ${requesterId}`
    : `<@${requesterId}> | ${requesterId}`;
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
