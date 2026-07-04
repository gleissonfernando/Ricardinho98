import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction
} from "discord.js";
import { isBotModuleEnabled } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import type { FivemHierarchyPanel } from "./apiClient";
import { resolvePanelImageUrl, type PanelVisualConfig, type PanelVisualPosition } from "./panelVisualRenderer";

const scheduledGuilds = new Map<string, NodeJS.Timeout>();

export const hierarchyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("hierarquia")
    .setDescription("Gerencia os paineis automaticos de hierarquia.")
    .addSubcommand((command) => command.setName("configurar").setDescription("Mostra onde configurar unidades, cargos e o painel."))
    .addSubcommand((command) => command.setName("postar").setDescription("Posta ou edita uma unidade de hierarquia.").addStringOption((option) => option.setName("unidade").setDescription("DU, CBP, TRAFFIC, MARY, FAST, DAF ou SWAT").setRequired(true)))
    .addSubcommand((command) => command.setName("atualizar").setDescription("Atualiza uma unidade de hierarquia.").addStringOption((option) => option.setName("unidade").setDescription("DU, CBP, TRAFFIC, MARY, FAST, DAF ou SWAT").setRequired(true)))
    .addSubcommand((command) => command.setName("atualizar_todas").setDescription("Atualiza agora todos os paineis de hierarquia."))
    .addSubcommand((command) => command.setName("preview").setDescription("Mostra uma preview privada da unidade.").addStringOption((option) => option.setName("unidade").setDescription("DU, CBP, TRAFFIC, MARY, FAST, DAF ou SWAT").setRequired(true)))
    .addSubcommand((command) => command.setName("resetar").setDescription("Orienta o reset do modelo pela dashboard.").addStringOption((option) => option.setName("unidade").setDescription("Unidade que sera resetada na dashboard").setRequired(false))),
  moduleId: "fivem-hierarchy",
  async execute(interaction: ChatInputCommandInteraction, context: BotContext) {
    if (!interaction.guild) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Voce precisa de permissao para gerenciar o servidor.", ephemeral: true });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "configurar" || subcommand === "resetar") {
      await interaction.reply({ content: "Configure as hierarquias, cargos/patentes, ordem, imagens, texto, rodape e canal na aba **Hierarquia** da Dashboard.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const unit = interaction.options.getString("unidade")?.trim().toLowerCase() ?? null;
    if (subcommand === "preview") {
      const panel = await findHierarchyPanel(interaction.guild.id, context, unit);
      if (!panel) {
        await interaction.editReply("Unidade de hierarquia nao encontrada ou desativada.");
        return;
      }
      await interaction.editReply(createHierarchyPayload(interaction.guild, panel, panel.imageUrl ? { imageEnabled: true, imagePosition: panel.imagePosition === "thumbnail" ? "side" : panel.imagePosition, imageUrl: panel.imageUrl } : null));
      return;
    }
    await refreshHierarchyPanelsForGuild(interaction.guild, context, subcommand === "atualizar_todas" ? null : unit);
    await interaction.editReply(subcommand === "atualizar_todas" ? "Todos os paineis de hierarquia foram atualizados." : "Painel de hierarquia atualizado.");
  }
};

export function startFivemHierarchyService(client: Client<true>, context: BotContext) {
  context.socket.onFivemHierarchyPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (guild) void refreshHierarchyPanelsForGuild(guild, context, payload.panelId);
  });

  for (const guild of client.guilds.cache.values()) {
    scheduleHierarchyRefresh(guild, context);
  }
}

export async function handleFivemHierarchyInteraction(interaction: Interaction, context: BotContext) {
  void interaction;
  void context;
  return false;
}

export function scheduleHierarchyRefresh(guild: Guild, context: BotContext) {
  if (!isBotModuleEnabled("fivem-hierarchy")) return;
  const current = scheduledGuilds.get(guild.id);
  if (current) clearTimeout(current);
  const timeout = setTimeout(() => {
    scheduledGuilds.delete(guild.id);
    void refreshHierarchyPanelsForGuild(guild, context);
  }, 2500);
  timeout.unref();
  scheduledGuilds.set(guild.id, timeout);
}

export async function refreshHierarchyPanelsForGuild(guild: Guild, context: BotContext, panelId?: string | null) {
  const panels = await context.api.getActiveFivemHierarchyPanels().catch(() => []);
  const lookup = panelId?.trim().toLowerCase() ?? null;
  const scoped = panels.filter((panel) => panel.guildId === guild.id && (!lookup || panel.id === panelId || panel.unitId?.toLowerCase() === lookup));
  if (!scoped.length) return;
  await guild.members.fetch().catch(() => null);
  for (const panel of scoped) {
    await publishHierarchyPanel(guild, context, panel);
  }
}

async function publishHierarchyPanel(guild: Guild, context: BotContext, panel: FivemHierarchyPanel) {
  if (!panel.enabled || !panel.panelChannelId) return;
  const channel = await guild.channels.fetch(panel.panelChannelId).catch(() => null);
  if (!channel || !("send" in channel) || !("messages" in channel)) return;
  const visuals = await getPanelVisualSlots(context, guild.id, panel.id);
  const payload = createHierarchyPayload(guild, panel, visuals[0] ?? null, visuals.slice(1));
  let message = panel.panelMessageId ? await channel.messages.fetch(panel.panelMessageId).catch(() => null) : null;
  if (message) {
    await message.edit(payload);
  } else {
    message = await channel.send(payload).catch(() => null);
  }
  if (message) {
    await context.api.updateFivemHierarchyPanelState({ guildId: guild.id, messageId: message.id, panelId: panel.id }).catch(() => null);
  }
}

function createHierarchyPayload(guild: Guild, panel: FivemHierarchyPanel, visual: PanelVisualConfig | null, extraImages: PanelVisualConfig[] = []) {
  const fallbackVisual: PanelVisualConfig | null = panel.imageUrl ? { imageEnabled: true, imagePosition: panel.imagePosition === "thumbnail" ? "side" : panel.imagePosition === "bottom" ? "bottom" : panel.imagePosition, imageUrl: panel.imageUrl } : null;
  const footerText = panel.footerEnabled ? (panel.useGlobalFooter ? panel.globalFooterText : panel.footerText) : null;
  const footerIconUrl = panel.footerEnabled ? (panel.useGlobalFooter ? panel.globalFooterIconUrl : panel.footerIconUrl) : null;
  const mainVisual = visual?.imageEnabled ? visual : fallbackVisual;
  const mainImageUrl = resolvePanelImageUrl(mainVisual?.imageUrl ?? null);
  const mainImagePosition = normalizeHierarchyMainImagePosition(mainVisual?.imagePosition);
  const sideImageUrl = mainImageUrl && ["side", "thumbnail"].includes(mainImagePosition) ? mainImageUrl : null;
  const header = [`**${panel.title}**`, panel.description ?? `Lista de membros da unidade ${panel.name}`].filter(Boolean).join("\n");
  const components: unknown[] = [];

  pushHierarchyMedia(components, mainImageUrl, mainImagePosition, ["top", "banner"], panel.title);
  pushExtraHierarchyMedia(components, extraImages, ["top", "banner"], panel.title);

  components.push(sideImageUrl
    ? { type: 9, components: [{ type: 10, content: header }], accessory: { type: 11, media: { url: sideImageUrl }, description: panel.title } }
    : { type: 10, content: header });

  pushExtraHierarchyMedia(components, extraImages, ["below_title"], panel.title);
  components.push({ type: 10, content: renderHierarchyText(guild, panel) });
  pushHierarchyMedia(components, mainImageUrl, mainImagePosition, ["bottom", "footer"], panel.title);
  pushExtraHierarchyMedia(components, extraImages, ["bottom", "footer", "below_text"], panel.title);

  if (footerText) {
    components.push({ type: 14, divider: true, spacing: 1 });
    const resolvedFooterIconUrl = resolvePanelImageUrl(footerIconUrl);
    components.push(resolvedFooterIconUrl
      ? { type: 9, components: [{ type: 10, content: `-# **${footerText}**` }], accessory: { type: 11, media: { url: resolvedFooterIconUrl }, description: footerText.slice(0, 100) } }
      : { type: 10, content: `-# **${footerText}**` });
  }

  return {
    allowedMentions: { parse: [] as never[] },
    components: [{ type: 17, accent_color: colorToInt(panel.color), components }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

export function getHierarchyPanelVisualIds(basePanelId: string) {
  return [basePanelId, `${basePanelId}-banner-2`, `${basePanelId}-banner-3`];
}

async function getPanelVisualSlots(context: BotContext, guildId: string, basePanelId: string) {
  const panelIds = getHierarchyPanelVisualIds(basePanelId);
  const visuals = await Promise.all(panelIds.map((panelId) => context.api.getPanelVisualSettings(guildId, panelId).catch(() => null)));

  return visuals.flatMap((visual, index): PanelVisualConfig[] => {
    if (!visual?.imageEnabled) return [];
    if (index > 0 && visual.useGlobalDefault) return [];
    return [{ imageEnabled: visual.imageEnabled, imagePosition: visual.imagePosition, imageUrl: visual.imageUrl }];
  });
}

function renderHierarchyText(guild: Guild, panel: FivemHierarchyPanel) {
  const listedMemberIds = new Set<string>();

  return panel.hierarchies
    .filter((item) => item.active)
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const candidates = item.roleId ? Array.from(guild.members.cache.values())
        .filter((member) => member.roles.cache.has(item.roleId) && !listedMemberIds.has(member.id))
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR")) : [];
      candidates.forEach((member) => listedMemberIds.add(member.id));
      const members = candidates
        .slice(0, item.limit ?? 50)
        .map((member) => formatHierarchyMember(member, panel.displayMode));
      if (!members.length && item.showWhenEmpty === false) return null;
      const heading = [item.emoji, `**${item.name}**`].filter(Boolean).join(" ");
      return `${heading}\n${members.length ? members.join("\n") : (item.emptyText || panel.emptyText || "Nenhum membro")}`;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
    .slice(0, 3800) || "*Nenhuma hierarquia configurada.*";
}

async function findHierarchyPanel(guildId: string, context: BotContext, unitId: string | null) {
  const panels = await context.api.getActiveFivemHierarchyPanels().catch(() => []);
  const lookup = unitId?.toLowerCase() ?? "";
  return panels.find((panel) => panel.guildId === guildId && (panel.unitId?.toLowerCase() === lookup || panel.id === unitId)) ?? null;
}

function formatHierarchyMember(member: GuildMember, mode: FivemHierarchyPanel["displayMode"]) {
  if (mode === "display_name") return member.displayName;
  if (mode === "nickname") return member.nickname || member.displayName;
  if (mode === "name_with_id") return `${member.displayName} - ${member.id}`;
  return `<@${member.id}>`;
}

function colorToInt(value: string) {
  return Number.parseInt(value.replace("#", ""), 16) || 0x22c55e;
}

function normalizeHierarchyImagePosition(position: PanelVisualPosition | undefined) {
  if (!position || position === "none") return "none";
  return position;
}

function normalizeHierarchyMainImagePosition(position: PanelVisualPosition | undefined) {
  const normalized = normalizeHierarchyImagePosition(position);
  return normalized === "banner" || normalized === "thumbnail" ? "side" : normalized;
}

function pushHierarchyMedia(components: unknown[], imageUrl: string | null, position: PanelVisualPosition | "none", acceptedPositions: string[], description: string) {
  if (imageUrl && acceptedPositions.includes(position)) {
    components.push(hierarchyMediaBlock(imageUrl, description));
  }
}

function pushExtraHierarchyMedia(components: unknown[], images: PanelVisualConfig[], acceptedPositions: string[], description: string) {
  images.forEach((image) => {
    const imageUrl = image.imageEnabled ? resolvePanelImageUrl(image.imageUrl ?? null) : null;
    const position = normalizeHierarchyImagePosition(image.imagePosition);
    if (imageUrl && acceptedPositions.includes(position)) {
      components.push(hierarchyMediaBlock(imageUrl, description));
    }
  });
}

function hierarchyMediaBlock(imageUrl: string, description: string) {
  return { type: 12, items: [{ media: { url: imageUrl }, description }] };
}
