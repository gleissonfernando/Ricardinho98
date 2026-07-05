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
const publishingPanels = new Map<string, Promise<void>>();

export const hierarchyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("hierarquia")
    .setDescription("Gerencia os paineis automaticos de hierarquia.")
    .addSubcommand((command) => command.setName("config").setDescription("Abre a configuracao das hierarquias."))
    .addSubcommand((command) => command.setName("sync").setDescription("Sincroniza agora todos os paineis de hierarquia."))
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
    if (subcommand === "config" || subcommand === "configurar" || subcommand === "resetar") {
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
    const syncAll = subcommand === "sync" || subcommand === "atualizar_todas";
    await refreshHierarchyPanelsForGuild(interaction.guild, context, syncAll ? null : unit);
    await interaction.editReply(syncAll ? "Todos os paineis de hierarquia foram atualizados." : "Painel de hierarquia atualizado.");
  }
};

export function startFivemHierarchyService(client: Client<true>, context: BotContext) {
  context.socket.onFivemHierarchyPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (guild) scheduleHierarchyRefresh(guild, context);
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

export function scheduleHierarchyRefresh(guild: Guild, context: BotContext, panelId?: string | null) {
  if (!isBotModuleEnabled("fivem-hierarchy")) return;
  const key = `${guild.id}:${panelId ?? "all"}`;
  const current = scheduledGuilds.get(key);
  if (current) clearTimeout(current);
  const timeout = setTimeout(() => {
    scheduledGuilds.delete(key);
    void refreshHierarchyPanelsForGuild(guild, context, panelId);
  }, 2500);
  timeout.unref();
  scheduledGuilds.set(key, timeout);
}

export async function scheduleHierarchyRefreshForMemberUpdate(oldMember: GuildMember, newMember: GuildMember, context: BotContext) {
  if (!isBotModuleEnabled("fivem-hierarchy")) return;

  const oldRoleIds = new Set(oldMember.roles.cache.keys());
  const newRoleIds = new Set(newMember.roles.cache.keys());
  const changedRoleIds = new Set<string>();

  for (const roleId of newRoleIds) {
    if (!oldRoleIds.has(roleId)) changedRoleIds.add(roleId);
  }

  for (const roleId of oldRoleIds) {
    if (!newRoleIds.has(roleId)) changedRoleIds.add(roleId);
  }

  const nameChanged = oldMember.displayName !== newMember.displayName || oldMember.nickname !== newMember.nickname;
  if (!changedRoleIds.size && !nameChanged) return;

  const panels = await context.api.getActiveFivemHierarchyPanels().catch(() => []);
  const affectedPanelIds = new Set<string>();

  for (const panel of panels) {
    if (panel.guildId !== newMember.guild.id || !panel.enabled) continue;

    const configuredRoleIds = configuredHierarchyRoleIds(panel);
    if (!configuredRoleIds.size) continue;

    if (changedRoleIds.size && intersects(changedRoleIds, configuredRoleIds)) {
      affectedPanelIds.add(panel.id);
      continue;
    }

    if (nameChanged && (memberHasAnyRole(oldMember, configuredRoleIds) || memberHasAnyRole(newMember, configuredRoleIds))) {
      affectedPanelIds.add(panel.id);
    }
  }

  if (!affectedPanelIds.size) return;

  console.log(`[HIERARQUIA] Alteracao relevante detectada para ${newMember.user.tag}. Atualizando ${affectedPanelIds.size} painel(is).`);
  for (const panelId of affectedPanelIds) {
    scheduleHierarchyRefresh(newMember.guild, context, panelId);
  }
}

export async function refreshHierarchyPanelsForGuild(guild: Guild, context: BotContext, panelId?: string | null) {
  const panels = await context.api.getActiveFivemHierarchyPanels().catch(() => []);
  const lookup = panelId?.trim().toLowerCase() ?? null;
  const scoped = panels.filter((panel) => panel.guildId === guild.id && (!lookup || panel.id === panelId || panel.unitId?.toLowerCase() === lookup));
  if (!scoped.length) return;
  await Promise.all([
    guild.members.fetch(),
    guild.roles.fetch(),
    guild.channels.fetch()
  ]);
  for (const panel of scoped) {
    await publishHierarchyPanelOnce(guild, context, panel);
  }
}

export async function atualizarTodasHierarquias(guild: Guild, context: BotContext) {
  await refreshHierarchyPanelsForGuild(guild, context, null);
}

async function publishHierarchyPanelOnce(guild: Guild, context: BotContext, panel: FivemHierarchyPanel) {
  const key = `${guild.id}:${panel.id}`;
  const current = publishingPanels.get(key);
  if (current) {
    await current;
    return;
  }

  const task = publishHierarchyPanel(guild, context, panel).finally(() => {
    publishingPanels.delete(key);
  });
  publishingPanels.set(key, task);
  await task;
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
  renderHierarchyTextChunks(guild, panel).forEach((content) => components.push({ type: 10, content }));
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

function renderHierarchyTextChunks(guild: Guild, panel: FivemHierarchyPanel) {
  const membersByBlock = collectHierarchyMembersForPanel(guild, panel).reduce((acc, item) => {
    const current = acc.get(item.blockId) ?? [];
    current.push(item.member);
    acc.set(item.blockId, current);
    return acc;
  }, new Map<string, GuildMember[]>());

  const blocks = panel.hierarchies
    .filter((item) => item.active)
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const candidates = (membersByBlock.get(item.id) ?? [])
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR"));
      const displayedCandidates = candidates.slice(0, item.limit ?? 50);
      const members = displayedCandidates.map((member) => formatHierarchyMember(member, panel.displayMode));
      if (!members.length && item.showWhenEmpty === false) return null;
      const heading = [item.emoji, `**${item.name}**`].filter(Boolean).join(" ");
      return `${heading}\n${members.length ? members.join("\n") : (item.emptyText || panel.emptyText || "Nenhum membro")}`;
    })
    .filter((value): value is string => Boolean(value));

  if (!blocks.length) return ["*Nenhuma hierarquia configurada.*"];
  return chunkHierarchyBlocks(blocks);
}

export function collectHierarchyMembersForPanel(guild: Pick<Guild, "members">, panel: FivemHierarchyPanel) {
  const entries: Array<{ blockId: string; member: GuildMember; panelId: string; roleId: string; userId: string }> = [];
  const seenInBlock = new Set<string>();

  for (const block of panel.hierarchies.filter((item) => item.active)) {
    if (!block.roleId) continue;

    const membersWithRole = guild.members.cache.filter((member) => member.roles.cache.has(block.roleId));
    for (const member of membersWithRole.values()) {
      const key = `${panel.id}:${block.id}:${member.id}`;
      if (seenInBlock.has(key)) continue;
      seenInBlock.add(key);
      entries.push({
        blockId: block.id,
        member,
        panelId: panel.id,
        roleId: block.roleId,
        userId: member.id
      });
    }
  }

  return entries;
}

function configuredHierarchyRoleIds(panel: FivemHierarchyPanel) {
  return new Set(panel.hierarchies
    .filter((item) => item.active && item.roleId)
    .map((item) => item.roleId));
}

function intersects(left: Set<string>, right: Set<string>) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function memberHasAnyRole(member: GuildMember, roleIds: Set<string>) {
  for (const roleId of roleIds) {
    if (member.roles.cache.has(roleId)) return true;
  }
  return false;
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
  return normalized === "none" ? "none" : "side";
}

function chunkHierarchyBlocks(blocks: string[]) {
  const chunks: string[] = [];
  let current = "";

  blocks.forEach((block) => {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > 3800 && current) {
      chunks.push(current);
      current = block;
      return;
    }
    current = next;
  });

  if (current) chunks.push(current);
  return chunks.slice(0, 8);
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
