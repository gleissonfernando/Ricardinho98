import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import { isBotModuleEnabled } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import type { FivemHierarchyPanel } from "./apiClient";
import { renderComponentsV2Panel, resolvePanelImageUrl, type PanelVisualConfig, type PanelVisualPosition } from "./panelVisualRenderer";

const scheduledGuilds = new Map<string, NodeJS.Timeout>();
const autoRefreshTimers = new Map<string, NodeJS.Timeout>();
const publishingPanels = new Map<string, Promise<void>>();
const hierarchyMemberSnapshots = new Map<string, Map<string, GuildMember>>();
const hierarchyPanelVisuals = new Map<string, { expiresAt: number; visuals: PanelVisualConfig[] }>();
const hierarchyPanelMessages = new Map<string, Message<true>>();
const HIERARCHY_REFRESH_PREFIX = "fivem_hierarchy:refresh";
const HIERARCHY_CONFIG_PREFIX = "fivem_hierarchy:config";
const HIERARCHY_MODAL_PREFIX = "fivem_hierarchy:modal";
const HIERARCHY_SELECT_PREFIX = "fivem_hierarchy:select";
const HIERARCHY_ROLE_PREFIX = "fivem_hierarchy:role";
const HIERARCHY_VISUAL_CACHE_MS = 60_000;
const HIERARCHY_AUTO_REFRESH_SECONDS = 5;
const HIERARCHY_MEMBER_FETCH_TIMEOUT_MS = 4_500;
let hierarchyRuntime: { client: Client<true>; context: BotContext } | null = null;

type HierarchyRefreshOptions = {
  allowCreate?: boolean;
  actorId?: string | null;
  automatic?: boolean;
};

type HierarchyMemberUpdateOptions = {
  diffReliable?: boolean;
};

export const hierarchyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("hierarquia")
    .setDescription("Gerencia os paineis automaticos de hierarquia.")
    .addSubcommand((command) => command.setName("config").setDescription("Abre a configuracao das hierarquias."))
    .addSubcommand((command) => command.setName("sync").setDescription("Sincroniza agora todos os paineis de hierarquia.")),
  moduleId: "fivem-hierarchy",
  async execute(interaction: ChatInputCommandInteraction, context: BotContext) {
    if (!interaction.guild) return;
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "config") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: "Voce precisa de permissao para gerenciar o servidor.", ephemeral: true });
        return;
      }
      await showFivemHierarchyConfigPanel(interaction, context);
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    if (subcommand === "sync" && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply("Voce precisa de permissao para gerenciar o servidor.");
      return;
    }
    await refreshHierarchyPanelsForGuild(interaction.guild, context, null, {
      actorId: interaction.user.id,
      allowCreate: true
    });
    await interaction.editReply("Todos os paineis de hierarquia foram atualizados.");
  }
};

export function startFivemHierarchyService(client: Client<true>, context: BotContext) {
  hierarchyRuntime = { client, context };

  context.socket.onFivemHierarchyPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    if (payload.action === "publish") {
      clearHierarchyPanelVisualCache(payload.guildId, payload.panelId);
      clearHierarchyPanelMessageCache(payload.guildId, payload.panelId);
      void refreshHierarchyPanelsForGuild(guild, context, payload.panelId, { allowCreate: true, automatic: false });
      void reconcileHierarchyAutoRefreshTimers(client, context, guild.id);
      return;
    }

    clearHierarchyPanelVisualCache(payload.guildId, payload.panelId);
    clearHierarchyPanelMessageCache(payload.guildId, payload.panelId);
    scheduleHierarchyRefresh(guild, context, payload.panelId, { allowCreate: true, automatic: false });
    void reconcileHierarchyAutoRefreshTimers(client, context, guild.id);
  });

  for (const guild of client.guilds.cache.values()) {
    scheduleHierarchyRefresh(guild, context, null, { allowCreate: true });
  }
  void reconcileHierarchyAutoRefreshTimers(client, context);
}

export async function handleFivemHierarchyInteraction(interaction: Interaction, context: BotContext) {
  if (
    !interaction.guild
    || !(
      (interaction.isButton() && (interaction.customId.startsWith(`${HIERARCHY_REFRESH_PREFIX}:`) || interaction.customId.startsWith(`${HIERARCHY_CONFIG_PREFIX}:`)))
      || (interaction.isModalSubmit() && interaction.customId.startsWith(`${HIERARCHY_MODAL_PREFIX}:`))
      || (interaction.isStringSelectMenu() && interaction.customId.startsWith(`${HIERARCHY_SELECT_PREFIX}:`))
      || (interaction.isRoleSelectMenu() && interaction.customId.startsWith(`${HIERARCHY_ROLE_PREFIX}:`))
    )
  ) {
    return false;
  }

  if (interaction.isButton() && interaction.customId.startsWith(`${HIERARCHY_CONFIG_PREFIX}:`)) {
    await handleHierarchyConfigButton(interaction, context);
    return true;
  }

  if (interaction.isModalSubmit()) {
    await handleHierarchyConfigModal(interaction, context);
    return true;
  }

  if (interaction.isStringSelectMenu()) {
    await handleHierarchyConfigSelect(interaction, context);
    return true;
  }

  if (interaction.isRoleSelectMenu()) {
    await handleHierarchyRoleSelect(interaction, context);
    return true;
  }

  if (interaction.isButton()) {
    await handleHierarchyRefreshButton(interaction, context);
  }
  return true;
}

export async function showFivemHierarchyConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return;
  const [panels, roles] = await Promise.all([loadActiveHierarchyPanels(context), interaction.guild.roles.fetch()]);
  const guildPanels = panels.filter((panel) => panel.guildId === interaction.guild!.id);
  const missing = guildPanels
    .flatMap((panel) => panel.hierarchies
      .filter((item) => item.roleId && !roles.has(item.roleId))
      .map((item) => `${panel.name}: ${item.name} (${item.roleId})`));
  await interaction.reply({
    ...hierarchyConfigPanelPayload(guildPanels.length, missing),
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

export function scheduleHierarchyRefresh(guild: Guild, context: BotContext, panelId?: string | null, options: HierarchyRefreshOptions = {}) {
  if (!isBotModuleEnabled("fivem-hierarchy")) return;
  const key = `${guild.id}:${panelId ?? "all"}`;
  const current = scheduledGuilds.get(key);
  if (current) clearTimeout(current);
  const timeout = setTimeout(() => {
    scheduledGuilds.delete(key);
    void refreshHierarchyPanelsForGuild(guild, context, panelId, options);
  }, 2500);
  timeout.unref();
  scheduledGuilds.set(key, timeout);
}

export async function scheduleHierarchyRefreshForMemberUpdate(oldMember: GuildMember, newMember: GuildMember, context: BotContext, options: HierarchyMemberUpdateOptions = {}) {
  if (!isBotModuleEnabled("fivem-hierarchy")) return;

  const oldRoleIds = new Set((getSnapshotHierarchyMember(newMember.guild.id, newMember.id) ?? oldMember).roles.cache.keys());
  const newRoleIds = new Set(newMember.roles.cache.keys());
  const changedRoleIds = new Set<string>();
  const addedRoleIds: string[] = [];
  const removedRoleIds: string[] = [];

  for (const roleId of newRoleIds) {
    if (!oldRoleIds.has(roleId)) {
      changedRoleIds.add(roleId);
      addedRoleIds.push(roleId);
    }
  }

  for (const roleId of oldRoleIds) {
    if (!newRoleIds.has(roleId)) {
      changedRoleIds.add(roleId);
      removedRoleIds.push(roleId);
    }
  }

  const nameChanged = oldMember.displayName !== newMember.displayName || oldMember.nickname !== newMember.nickname;
  const panels = await loadActiveHierarchyPanels(context);
  const guildPanels = panels.filter((panel) => panel.guildId === newMember.guild.id && panel.autoUpdateEnabled !== false);
  if (!changedRoleIds.size && !nameChanged && options.diffReliable !== false) return;
  const affectedPanels = selectHierarchyPanelsForMemberUpdate(
    guildPanels,
    changedRoleIds,
    options.diffReliable === false && !changedRoleIds.size
      ? new Set(guildPanels.flatMap((panel) => panel.hierarchies.map((item) => item.roleId).filter(Boolean)))
      : nameChanged ? newRoleIds : new Set<string>()
  );
  if (!affectedPanels.length) return;

  console.log(JSON.stringify({
    action: "hierarchy.member_change_detected",
    addedRoleIds,
    affectedPanelIds: affectedPanels.map((panel) => panel.id),
    diffReliable: options.diffReliable !== false,
    guildId: newMember.guild.id,
    nameChanged,
    removedRoleIds,
    userId: newMember.id
  }));
  const members = resolveHierarchyMembersForMemberUpdate(newMember)
    ?? rememberHierarchyMembers(newMember.guild.id, mergeMemberIntoCache(newMember.guild.members.cache, newMember));
  if (!members) return;
  const knownRoleIds = new Set(newMember.guild.roles.cache.keys());
  await Promise.all(affectedPanels.map((panel) => syncHierarchyPanel(
    newMember.guild.id,
    panel.id,
    newMember.guild,
    context,
    { allowCreate: false },
    panel,
    members,
    knownRoleIds
  )));

  if (!isHierarchyMemberCacheComplete(newMember.guild.members.cache.size, newMember.guild.memberCount)) {
    scheduleHierarchyRefresh(newMember.guild, context, null, { allowCreate: false });
  }
}

export function selectHierarchyPanelsForMemberUpdate(
  panels: FivemHierarchyPanel[],
  changedRoleIds: Set<string>,
  currentRoleIds: Set<string>
) {
  return panels.filter((panel) => panel.hierarchies.some((item) => item.active
    && item.roleId
    && (changedRoleIds.has(item.roleId) || currentRoleIds.has(item.roleId))));
}

export function isHierarchyMemberCacheComplete(cachedMemberCount: number, guildMemberCount: number) {
  return cachedMemberCount >= guildMemberCount;
}

export async function refreshHierarchyPanelsForGuild(guild: Guild, context: BotContext, panelId?: string | null, options: HierarchyRefreshOptions = {}) {
  const panels = await loadActiveHierarchyPanels(context);
  const lookup = panelId?.trim().toLowerCase() ?? null;
  const automatic = options.automatic !== false && !options.actorId;
  const scoped = panels.filter((panel) => panel.guildId === guild.id
    && (!lookup || panel.id === panelId || panel.unitId?.toLowerCase() === lookup)
    && (!automatic || panel.autoUpdateEnabled !== false));
  if (!scoped.length) return;
  const [members, roles] = await Promise.all([
    fetchHierarchyMembers(guild),
    guild.roles.fetch(),
    guild.channels.fetch()
  ]);
  if (!members) return;
  for (const panel of scoped) {
    await syncHierarchyPanel(guild.id, panel.id, guild, context, options, panel, members, new Set(roles.keys()));
  }
}

export async function atualizarTodasHierarquias(guild: Guild, context: BotContext) {
  await refreshHierarchyPanelsForGuild(guild, context, null, { allowCreate: true });
}

export async function syncHierarchyPanel(
  guildId: string,
  hierarchyId: string,
  guild?: Guild,
  context?: BotContext,
  options: HierarchyRefreshOptions = {},
  knownPanel?: FivemHierarchyPanel,
  knownMembers?: HierarchyMemberCache,
  knownRoleIds?: Set<string>
) {
  context ??= hierarchyRuntime?.context;
  guild ??= hierarchyRuntime?.client.guilds.cache.get(guildId);
  if (!context || !guild) {
    console.warn(`[HIERARQUIA] syncHierarchyPanel sem contexto ativo para guild=${guildId} hierarchy=${hierarchyId}.`);
    return;
  }
  if (guild.id !== guildId) return;
  const panel = knownPanel ?? (await context.api.getActiveFivemHierarchyPanels().catch(() => []))
    .find((item) => item.guildId === guildId && item.id === hierarchyId);
  if (!panel?.enabled) return;
  const [members, roles] = await Promise.all([
    knownMembers ? Promise.resolve(knownMembers) : fetchHierarchyMembers(guild),
    knownRoleIds ? Promise.resolve(knownRoleIds) : guild.roles.fetch().then((collection) => new Set(collection.keys()))
  ]);
  if (!members) return;
  await publishHierarchyPanelOnce(guild, context, panel, members, options);
  const processedRoleIds = [...new Set(panel.hierarchies.filter((item) => item.active && item.roleId).map((item) => item.roleId))];
  const missingRoleIds = processedRoleIds.filter((roleId) => !roles.has(roleId));
  const memberCount = new Set(collectHierarchyMembersForPanel(members, panel).map((item) => item.userId)).size;
  await context.api.recordFivemHierarchySync({
    actorId: options.actorId ?? null,
    guildId,
    hierarchyId,
    memberCount,
    missingRoleIds,
    processedRoleIds
  }).catch(() => undefined);
  console.log(JSON.stringify({
    action: "Hierarquia atualizada",
    actorId: options.actorId ?? null,
    guildId,
    hierarchyId,
    memberCount,
    missingRoleIds,
    processedRoleIds
  }));
}

export const atualizarHierarquia = syncHierarchyPanel;

async function publishHierarchyPanelOnce(guild: Guild, context: BotContext, panel: FivemHierarchyPanel, members?: HierarchyMemberCache, options: HierarchyRefreshOptions = {}) {
  const key = `${guild.id}:${panel.id}`;
  const current = publishingPanels.get(key);
  if (current) {
    await current;
    return publishHierarchyPanelOnce(guild, context, panel, members, options);
  }

  const task = publishHierarchyPanel(guild, context, panel, members, options).finally(() => {
    publishingPanels.delete(key);
  });
  publishingPanels.set(key, task);
  await task;
}

async function publishHierarchyPanel(guild: Guild, context: BotContext, panel: FivemHierarchyPanel, members?: HierarchyMemberCache, options: HierarchyRefreshOptions = {}) {
  if (!panel.enabled || !panel.panelChannelId) return;
  const allowCreate = options.allowCreate !== false;
  const channel = getCachedHierarchyPanelChannel(guild, panel.panelChannelId)
    ?? await guild.channels.fetch(panel.panelChannelId).catch(() => null);
  if (!channel || !("send" in channel) || !("messages" in channel)) return;
  const visuals = await getPanelVisualSlots(context, guild.id, panel.id);
  const payload = createHierarchyPayload(guild, panel, visuals[0] ?? null, visuals.slice(1), members);
  let message = getCachedHierarchyPanelMessage(guild.id, panel, channel);
  if (!message && panel.panelMessageId) {
    message = await channel.messages.fetch(panel.panelMessageId).catch(() => null);
  }
  const matchingMessages = options.allowCreate !== false
    ? await findHierarchyPanelMessages(channel, guild.client.user.id, panel)
    : [];
  if (!message) message = matchingMessages[0] ?? null;

  if (message) {
    message = await message.edit(payload).catch(async (error) => {
      forgetHierarchyPanelMessage(guild.id, panel.id);
      if (!panel.panelMessageId) return null;
      console.warn(`[HIERARQUIA] Falha ao editar mensagem em cache do painel ${panel.id}; tentando buscar novamente.`, error instanceof Error ? error.message : error);
      const freshMessage = await channel.messages.fetch(panel.panelMessageId).catch(() => null);
      return freshMessage ? freshMessage.edit(payload).catch(() => null) : null;
    });
  } else if (!allowCreate) {
    console.log(`[HIERARQUIA] Painel ${panel.name} sem mensagem salva/encontrada. Atualizacao automatica nao criou painel novo.`);
    return;
  } else {
    message = await channel.send(payload).catch(() => null);
  }
  if (!message) return;
  rememberHierarchyPanelMessage(guild.id, panel.id, message);

  const savedPanel = await context.api.updateFivemHierarchyPanelState({
    expectedMessageId: panel.panelMessageId,
    guildId: guild.id,
    messageId: message.id,
    panelId: panel.id
  }).catch(() => null);
  if (savedPanel?.panelMessageId && savedPanel.panelMessageId !== message.id) {
    forgetHierarchyPanelMessage(guild.id, panel.id);
    await message.delete().catch(() => undefined);
    const canonicalMessage = await channel.messages.fetch(savedPanel.panelMessageId).catch(() => null);
    if (canonicalMessage) {
      const edited = await canonicalMessage.edit(payload);
      rememberHierarchyPanelMessage(guild.id, panel.id, edited);
    }
    return;
  }

  const duplicates = matchingMessages.filter((candidate) => candidate.id !== message.id);
  await Promise.allSettled(duplicates.map((candidate) => candidate.delete()));
}

function createHierarchyPayload(guild: Guild, panel: FivemHierarchyPanel, visual: PanelVisualConfig | null, extraImages: PanelVisualConfig[] = [], members?: HierarchyMemberCache) {
  const fallbackVisual: PanelVisualConfig | null = panel.imageUrl ? { imageEnabled: true, imagePosition: panel.imagePosition === "thumbnail" ? "side" : panel.imagePosition === "bottom" ? "bottom" : panel.imagePosition, imageUrl: panel.imageUrl } : null;
  const footerText = panel.footerEnabled ? (panel.useGlobalFooter ? panel.globalFooterText : panel.footerText) : null;
  const footerIconUrl = panel.footerEnabled ? (panel.useGlobalFooter ? panel.globalFooterIconUrl : panel.footerIconUrl) : null;
  const mainVisual = visual?.imageEnabled ? visual : fallbackVisual;
  const mainImageUrl = resolvePanelImageUrl(mainVisual?.imageUrl ?? null);
  const mainImagePosition = normalizeHierarchyMainImagePosition(mainVisual?.imagePosition);
  const sideImageUrl = mainImageUrl && ["side", "thumbnail"].includes(mainImagePosition) ? mainImageUrl : null;
  const title = formatHierarchyTitle(panel);
  const description = panel.description ?? `Lista oficial de membros da unidade ${panel.name}`;
  const updatedAt = formatHierarchyUpdatedAt(new Date());
  const header = [`# ${title}`, description, `-# 🔄 Atualizado automaticamente em: ${updatedAt}`].filter(Boolean).join("\n");
  const components: unknown[] = [];

  pushHierarchyMedia(components, mainImageUrl, mainImagePosition, ["top", "banner"], panel.title);
  pushExtraHierarchyMedia(components, extraImages, ["top", "banner"], panel.title);

  components.push(sideImageUrl
    ? { type: 9, components: [{ type: 10, content: header }], accessory: { type: 11, media: { url: sideImageUrl }, description: panel.title } }
    : { type: 10, content: header });

  pushHierarchyMedia(components, mainImageUrl, mainImagePosition, ["below_title", "middle"], panel.title);
  pushExtraHierarchyMedia(components, extraImages, ["below_title", "middle"], panel.title);
  const missingRoleIds = getMissingHierarchyRoleIds(guild, panel);
  if (missingRoleIds.length) {
    components.push({ type: 10, content: `⚠️ **Cargos cadastrados não encontrados:**\n${missingRoleIds.map((roleId) => `\`${roleId}\``).join("\n")}` });
  }
  renderHierarchyTextBlocks(members ?? guild, panel).forEach((content, index) => {
    if (index > 0) components.push({ type: 14, divider: true, spacing: 1 });
    components.push({ type: 10, content });
  });
  pushHierarchyMedia(components, mainImageUrl, mainImagePosition, ["below_text", "before_buttons", "above_buttons"], panel.title);
  pushExtraHierarchyMedia(components, extraImages, ["side", "thumbnail", "below_text", "before_buttons", "above_buttons"], panel.title);
  pushHierarchyMedia(components, mainImageUrl, mainImagePosition, ["bottom", "footer"], panel.title);
  pushExtraHierarchyMedia(components, extraImages, ["bottom", "footer"], panel.title);

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
  return Array.from({ length: 8 }, (_, index) => index === 0 ? basePanelId : `${basePanelId}-banner-${index + 1}`);
}

async function getPanelVisualSlots(context: BotContext, guildId: string, basePanelId: string) {
  const cacheKey = `${guildId}:${basePanelId}`;
  const cached = hierarchyPanelVisuals.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.visuals;
  }

  const panelIds = getHierarchyPanelVisualIds(basePanelId);
  const visuals = await Promise.all(panelIds.map((panelId) => context.api.getPanelVisualSettings(guildId, panelId).catch(() => null)));

  const normalized = visuals.flatMap((visual, index): PanelVisualConfig[] => {
    if (!visual?.imageEnabled) return [];
    if (index > 0 && visual.useGlobalDefault) return [];
    return [{ imageEnabled: visual.imageEnabled, imagePosition: visual.imagePosition, imageUrl: visual.imageUrl }];
  });

  hierarchyPanelVisuals.set(cacheKey, {
    expiresAt: Date.now() + HIERARCHY_VISUAL_CACHE_MS,
    visuals: normalized
  });
  return normalized;
}

function renderHierarchyTextBlocks(memberSource: HierarchyMemberSource, panel: FivemHierarchyPanel) {
  const membersByBlock = collectHierarchyMembersForPanel(memberSource, panel).reduce((acc, item) => {
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
      const emptyText = item.emptyText || panel.emptyText || "Nenhum membro encontrado com este cargo.";
      const body = members.length ? members.map((member) => `> ${member}`).join("\n") : `> ${emptyText}`;
      return `${heading}\n${body}`;
    })
    .filter((value): value is string => Boolean(value));

  if (!blocks.length) return ["*Nenhuma hierarquia configurada.*"];
  return chunkHierarchyBlocks(blocks);
}

export function collectHierarchyMembersForPanel(memberSource: HierarchyMemberSource, panel: FivemHierarchyPanel) {
  const entries: Array<{ blockId: string; member: GuildMember; panelId: string; roleId: string; userId: string }> = [];
  const members = getHierarchyMemberCache(memberSource);
  const assignedBlockMembers = new Set<string>();
  const activeBlocks = panel.hierarchies
    .filter((item) => item.active && item.roleId)
    .sort((a, b) => a.order - b.order);

  for (const block of activeBlocks) {
    const membersWithRole = members.filter((member) => member.roles.cache.has(block.roleId) && !member.user?.bot);
    for (const member of membersWithRole.values()) {
      const assignmentKey = `${block.id}:${member.id}`;
      if (assignedBlockMembers.has(assignmentKey)) continue;
      assignedBlockMembers.add(assignmentKey);
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

type HierarchyMemberCache = {
  filter(predicate: (member: GuildMember) => boolean): { values(): IterableIterator<GuildMember> };
};

type HierarchyMemberSource = Pick<Guild, "members"> | HierarchyMemberCache;

async function fetchHierarchyMembers(guild: Guild): Promise<HierarchyMemberCache | null> {
  try {
    await guild.roles.fetch();
    const members = await guild.members.fetch({ time: HIERARCHY_MEMBER_FETCH_TIMEOUT_MS });
    if (!isHierarchyMemberCacheComplete(members.size, guild.memberCount)) {
      console.warn(`[HIERARQUIA] Consulta incompleta no servidor ${guild.id}: ${members.size}/${guild.memberCount} membros. Usando merge com snapshot local.`);
      return rememberHierarchyMembers(guild.id, mergeHierarchyMemberCaches(getSnapshotHierarchyMembers(guild.id), members));
    }
    return rememberHierarchyMembers(guild.id, members);
  } catch (error) {
    const snapshot = getSnapshotHierarchyMembers(guild.id);
    if (snapshot) {
      console.warn(`[HIERARQUIA] Falha ao buscar membros atualizados do servidor ${guild.id}. Usando snapshot local.`, error instanceof Error ? error.message : error);
      return snapshot;
    }
    console.error(`[HIERARQUIA] Falha ao buscar membros atualizados do servidor ${guild.id}. Verifique SERVER MEMBERS INTENT no Developer Portal.`, error);
    return rememberHierarchyMembers(guild.id, guild.members.cache);
  }
}

async function findHierarchyPanelMessages(
  channel: GuildTextBasedChannel,
  botUserId: string,
  panel: FivemHierarchyPanel
) {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return [];
  const title = formatHierarchyTitle(panel);
  return [...recent.values()].filter((message) => {
    if (message.author.id !== botUserId) return false;
    return JSON.stringify(message.components.map((component: { toJSON(): unknown }) => component.toJSON())).includes(title);
  });
}

function getHierarchyMemberCache(source: HierarchyMemberSource): HierarchyMemberCache {
  return "members" in source ? source.members.cache : source;
}

export function resolveHierarchyMembersForMemberUpdate(member: GuildMember) {
  const snapshot = hierarchyMemberSnapshots.get(member.guild.id);
  if (!snapshot) return null;
  const next = new Map(snapshot);
  next.set(member.id, member);
  hierarchyMemberSnapshots.set(member.guild.id, next);
  return createHierarchyMemberCache(next);
}

export function forgetHierarchyMember(guildId: string, userId: string) {
  const snapshot = hierarchyMemberSnapshots.get(guildId);
  if (!snapshot) return;
  const next = new Map(snapshot);
  next.delete(userId);
  hierarchyMemberSnapshots.set(guildId, next);
}

function getSnapshotHierarchyMember(guildId: string, userId: string) {
  return hierarchyMemberSnapshots.get(guildId)?.get(userId) ?? null;
}

function getSnapshotHierarchyMembers(guildId: string) {
  const snapshot = hierarchyMemberSnapshots.get(guildId);
  return snapshot ? createHierarchyMemberCache(new Map(snapshot)) : null;
}

function rememberHierarchyMembers(guildId: string, members: HierarchyMemberCache) {
  const snapshot = new Map<string, GuildMember>();
  for (const member of members.filter(() => true).values()) {
    snapshot.set(member.id, member);
  }
  hierarchyMemberSnapshots.set(guildId, snapshot);
  return createHierarchyMemberCache(snapshot);
}

function mergeHierarchyMemberCaches(base: HierarchyMemberCache | null, next: HierarchyMemberCache) {
  const snapshot = new Map<string, GuildMember>();
  if (base) {
    for (const member of base.filter(() => true).values()) {
      snapshot.set(member.id, member);
    }
  }
  for (const member of next.filter(() => true).values()) {
    snapshot.set(member.id, member);
  }
  return createHierarchyMemberCache(snapshot);
}

function mergeMemberIntoCache(members: HierarchyMemberCache, member: GuildMember) {
  const snapshot = new Map<string, GuildMember>();
  for (const cachedMember of members.filter(() => true).values()) {
    snapshot.set(cachedMember.id, cachedMember);
  }
  snapshot.set(member.id, member);
  return createHierarchyMemberCache(snapshot);
}

function createHierarchyMemberCache(members: Map<string, GuildMember>): HierarchyMemberCache {
  return {
    filter(predicate: (member: GuildMember) => boolean) {
      const filtered = new Map<string, GuildMember>();
      for (const [id, member] of members) {
        if (predicate(member)) filtered.set(id, member);
      }
      return {
        values: () => filtered.values()
      };
    }
  };
}

function clearHierarchyPanelVisualCache(guildId: string, panelId?: string | null) {
  if (panelId) {
    hierarchyPanelVisuals.delete(`${guildId}:${panelId}`);
    return;
  }

  for (const key of [...hierarchyPanelVisuals.keys()]) {
    if (key.startsWith(`${guildId}:`)) {
      hierarchyPanelVisuals.delete(key);
    }
  }
}

function clearHierarchyPanelMessageCache(guildId: string, panelId?: string | null) {
  if (panelId) {
    forgetHierarchyPanelMessage(guildId, panelId);
    return;
  }

  for (const key of [...hierarchyPanelMessages.keys()]) {
    if (key.startsWith(`${guildId}:`)) {
      hierarchyPanelMessages.delete(key);
    }
  }
}

function getCachedHierarchyPanelChannel(guild: Guild, channelId: string) {
  const channel = guild.channels.cache.get(channelId);
  return channel && "send" in channel && "messages" in channel ? channel : null;
}

function getCachedHierarchyPanelMessage(guildId: string, panel: FivemHierarchyPanel, channel: GuildTextBasedChannel) {
  const cached = hierarchyPanelMessages.get(hierarchyPanelMessageKey(guildId, panel.id));
  if (cached && (!panel.panelMessageId || cached.id === panel.panelMessageId)) return cached;
  return panel.panelMessageId ? channel.messages.cache.get(panel.panelMessageId) ?? null : null;
}

function rememberHierarchyPanelMessage(guildId: string, panelId: string, message: Message<true>) {
  hierarchyPanelMessages.set(hierarchyPanelMessageKey(guildId, panelId), message);
}

function forgetHierarchyPanelMessage(guildId: string, panelId: string) {
  hierarchyPanelMessages.delete(hierarchyPanelMessageKey(guildId, panelId));
}

function hierarchyPanelMessageKey(guildId: string, panelId: string) {
  return `${guildId}:${panelId}`;
}

function canEditHierarchyPanel(member: GuildMember, panel: FivemHierarchyPanel, hasManageGuild: boolean) {
  return hasManageGuild || panel.editorRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function findHierarchyPanel(guildId: string, context: BotContext, unitId: string | null) {
  const panels = await loadActiveHierarchyPanels(context);
  const lookup = unitId?.toLowerCase() ?? "";
  return panels.find((panel) => panel.guildId === guildId && (panel.unitId?.toLowerCase() === lookup || panel.id === unitId)) ?? null;
}

async function loadActiveHierarchyPanels(context: BotContext) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await context.api.getActiveFivemHierarchyPanels();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  console.error("[HIERARQUIA] Falha ao carregar paineis ativos apos 3 tentativas.", lastError);
  return [];
}

async function reconcileHierarchyAutoRefreshTimers(client: Client<true>, context: BotContext, guildId?: string) {
  const panels = await loadActiveHierarchyPanels(context);
  const activeKeys = new Set<string>();

  for (const panel of panels) {
    if (guildId && panel.guildId !== guildId) continue;
    const key = `${panel.guildId}:${panel.id}`;
    activeKeys.add(key);

    const guild = client.guilds.cache.get(panel.guildId);
    if (!guild || panel.autoUpdateEnabled === false || !panel.panelChannelId) {
      clearHierarchyAutoRefreshTimer(key);
      continue;
    }

    const intervalMs = HIERARCHY_AUTO_REFRESH_SECONDS * 1000;
    clearHierarchyAutoRefreshTimer(key);
    const timer = setInterval(() => {
      void refreshHierarchyPanelsForGuild(guild, context, panel.id, { allowCreate: false });
    }, intervalMs);
    timer.unref();
    autoRefreshTimers.set(key, timer);
  }

  for (const key of [...autoRefreshTimers.keys()]) {
    const [timerGuildId] = key.split(":");
    if ((!guildId || timerGuildId === guildId) && !activeKeys.has(key)) {
      clearHierarchyAutoRefreshTimer(key);
    }
  }
}

function clearHierarchyAutoRefreshTimer(key: string) {
  const timer = autoRefreshTimers.get(key);
  if (!timer) return;
  clearInterval(timer);
  autoRefreshTimers.delete(key);
}

function formatHierarchyMember(member: GuildMember, mode: FivemHierarchyPanel["displayMode"]) {
  if (mode === "display_name") return member.displayName;
  if (mode === "nickname") return member.nickname || member.displayName;
  if (mode === "name_with_id") return `${member.displayName} - ${member.id}`;
  return `<@${member.id}>`;
}

function formatHierarchyTitle(panel: FivemHierarchyPanel) {
  const configured = panel.title?.trim() || `Hierarquia - ${panel.name}`;
  const normalized = configured.replace(/\s+-\s+/g, " — ");
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(normalized) ? normalized : `📋 ${normalized}`;
}

function formatHierarchyUpdatedAt(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo"
  }).format(date).replace(",", " às");
}

async function handleHierarchyRefreshButton(interaction: ButtonInteraction, context: BotContext) {
  const panelId = interaction.customId.slice(`${HIERARCHY_REFRESH_PREFIX}:`.length);
  await interaction.deferReply({ ephemeral: true });
  const panel = await findHierarchyPanel(interaction.guildId!, context, panelId);
  if (!panel) {
    await interaction.editReply("Painel de hierarquia nao encontrado ou desativado.");
    return;
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
  const canEdit = member
    ? canEditHierarchyPanel(member, panel, interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true)
    : interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;

  if (!canEdit) {
    await interaction.editReply("Voce nao possui permissao para atualizar esta hierarquia.");
    return;
  }

  await syncHierarchyPanel(interaction.guildId!, panel.id, interaction.guild!, context, {
    actorId: interaction.user.id,
    allowCreate: true
  }, panel);
  await interaction.editReply("Hierarquia atualizada manualmente.");
}

async function handleHierarchyConfigButton(interaction: ButtonInteraction, context: BotContext) {
  const action = interaction.customId.slice(`${HIERARCHY_CONFIG_PREFIX}:`.length);
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Você não tem permissão para modificar esta hierarquia.", ephemeral: true });
    return;
  }

  if (action === "create") {
    await interaction.showModal(hierarchyCreateModal());
    return;
  }

  if (action === "refresh_all") {
    await interaction.deferReply({ ephemeral: true });
    await refreshHierarchyPanelsForGuild(interaction.guild!, context, null, {
      actorId: interaction.user.id,
      allowCreate: true
    });
    await interaction.editReply("Todos os painéis ativos de hierarquia foram atualizados.");
    return;
  }

  if (action === "list") {
    await interaction.deferReply({ ephemeral: true });
    const panels = await context.api.getFivemHierarchyPanels(interaction.guildId!);
    await interaction.editReply(panels.length
      ? panels.map((panel) => `• ${panel.name} | ID: \`${panel.id}\` | Canal: ${panel.panelChannelId ? `<#${panel.panelChannelId}>` : "não configurado"} | Cargos: ${panel.hierarchies.length}`).join("\n")
      : "Nenhuma hierarquia ativa encontrada para este servidor.");
    return;
  }

  if (action === "edit_name" || action === "edit_panel" || action === "add_role" || action === "delete" || action === "refresh_one") {
    await interaction.deferReply({ ephemeral: true });
    const panels = await context.api.getFivemHierarchyPanels(interaction.guildId!);
    if (!panels.length) {
      await interaction.editReply("Nenhuma hierarquia cadastrada neste servidor. Use **Cadastrar Hierarquia** primeiro.");
      return;
    }
    await interaction.editReply({
      components: [buildHierarchyPanelSelect(action, panels)],
      content: "Selecione a hierarquia que deseja alterar."
    });
    return;
  }

  if (action.startsWith("confirm_delete:")) {
    await interaction.deferReply({ ephemeral: true });
    const panelId = action.slice("confirm_delete:".length);
    await context.api.deleteFivemHierarchyPanel(interaction.guildId!, panelId);
    await interaction.editReply("Hierarquia excluída.");
    return;
  }

  await interaction.reply({ content: "Ação de hierarquia não reconhecida.", ephemeral: true });
}

async function handleHierarchyConfigSelect(interaction: StringSelectMenuInteraction, context: BotContext) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Você não tem permissão para modificar esta hierarquia.", ephemeral: true });
    return;
  }

  const action = interaction.customId.slice(`${HIERARCHY_SELECT_PREFIX}:`.length);
  const panelId = interaction.values[0];
  const panels = await context.api.getFivemHierarchyPanels(interaction.guildId!);
  const panel = panels.find((item) => item.id === panelId);
  if (!panel) {
    await interaction.update({ components: [], content: "Hierarquia não encontrada." });
    return;
  }

  if (action === "edit_name") {
    await interaction.showModal(hierarchyNameModal(panel));
    return;
  }

  if (action === "edit_panel") {
    await interaction.showModal(hierarchyPanelModal(panel));
    return;
  }

  if (action === "add_role") {
    await interaction.update({
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`${HIERARCHY_ROLE_PREFIX}:add:${panel.id}`)
          .setPlaceholder("Selecione o cargo que entra nesta hierarquia")
          .setMinValues(1)
          .setMaxValues(1)
      )],
      content: `Selecione o cargo para adicionar em **${panel.name}**.`
    });
    return;
  }

  if (action === "delete") {
    await interaction.update({
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:confirm_delete:${panel.id}`).setLabel("Confirmar exclusão").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:list`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
      )],
      content: `Confirme a exclusão da hierarquia **${panel.name}**.`
    });
    return;
  }

  if (action === "refresh_one") {
    await interaction.update({ components: [], content: `Atualizando **${panel.name}**...` });
    await syncHierarchyPanel(interaction.guildId!, panel.id, interaction.guild!, context, {
      actorId: interaction.user.id,
      allowCreate: true
    }, panel);
    await interaction.editReply(`Hierarquia **${panel.name}** atualizada.`);
  }
}

async function handleHierarchyRoleSelect(interaction: RoleSelectMenuInteraction, context: BotContext) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Você não tem permissão para modificar esta hierarquia.", ephemeral: true });
    return;
  }

  const [action, panelId] = interaction.customId.slice(`${HIERARCHY_ROLE_PREFIX}:`.length).split(":");
  if (action !== "add" || !panelId) {
    await interaction.reply({ content: "Ação de cargo inválida.", ephemeral: true });
    return;
  }

  const roleId = interaction.values[0];
  if (!roleId) {
    await interaction.update({ components: [], content: "Nenhum cargo selecionado." });
    return;
  }
  const role = await interaction.guild!.roles.fetch(roleId).catch(() => null);
  const panels = await context.api.getFivemHierarchyPanels(interaction.guildId!);
  const panel = panels.find((item) => item.id === panelId);
  if (!panel || !role) {
    await interaction.update({ components: [], content: "Hierarquia ou cargo não encontrado." });
    return;
  }

  if (panel.hierarchies.some((item) => item.roleId === role.id)) {
    await interaction.update({ components: [], content: "Esse cargo já está cadastrado nesta hierarquia." });
    return;
  }

  const saved = await context.api.saveFivemHierarchyPanel(interaction.guildId!, {
    id: panel.id,
    hierarchies: [
      ...panel.hierarchies,
      {
        active: true,
        color: null,
        description: null,
        emoji: null,
        emptyText: "Nenhum membro encontrado com este cargo.",
        id: `hierarquia-${Date.now()}`,
        limit: null,
        name: role.name,
        order: panel.hierarchies.length + 1,
        roleId: role.id,
        showWhenEmpty: true
      }
    ]
  });
  await interaction.update({ components: [], content: `Cargo <@&${role.id}> cadastrado em **${saved.name}**.` });
}

async function handleHierarchyConfigModal(interaction: ModalSubmitInteraction, context: BotContext) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Você não tem permissão para modificar esta hierarquia.", ephemeral: true });
    return;
  }

  const [action, panelId] = interaction.customId.slice(`${HIERARCHY_MODAL_PREFIX}:`.length).split(":");
  await interaction.deferReply({ ephemeral: true });

  if (action === "create") {
    const name = readModalField(interaction, "name", 100) || "Nova Hierarquia";
    const title = readModalField(interaction, "title", 120) || `Hierarquia - ${name}`;
    const description = readModalField(interaction, "description", 1200) || "Lista oficial de membros agrupados por cargos.";
    const color = normalizeModalColor(readModalField(interaction, "color", 7));
    const panelChannelId = normalizeModalSnowflake(readModalField(interaction, "channelId", 32));
    const saved = await context.api.saveFivemHierarchyPanel(interaction.guildId!, {
      color,
      description,
      enabled: true,
      hierarchies: [],
      name,
      panelChannelId,
      title,
      unitId: `custom-${Date.now()}`
    });
    await interaction.editReply(`Hierarquia **${saved.name}** criada. Use **Cadastrar Cargos** para adicionar cargos.`);
    return;
  }

  if (!panelId) {
    await interaction.editReply("Hierarquia inválida.");
    return;
  }

  if (action === "edit_name") {
    const name = readModalField(interaction, "name", 100);
    if (!name) {
      await interaction.editReply("Informe um nome válido.");
      return;
    }
    const saved = await context.api.saveFivemHierarchyPanel(interaction.guildId!, { id: panelId, name, title: `Hierarquia - ${name}` });
    await interaction.editReply(`Nome atualizado para **${saved.name}**.`);
    return;
  }

  if (action === "edit_panel") {
    const title = readModalField(interaction, "title", 120);
    const description = readModalField(interaction, "description", 1200);
    const color = normalizeModalColor(readModalField(interaction, "color", 7));
    const panelChannelId = normalizeModalSnowflake(readModalField(interaction, "channelId", 32));
    const saved = await context.api.saveFivemHierarchyPanel(interaction.guildId!, {
      id: panelId,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      color,
      panelChannelId
    });
    await interaction.editReply(`Painel **${saved.name}** atualizado.`);
  }
}

function hierarchyCreateModal() {
  return new ModalBuilder()
    .setCustomId(`${HIERARCHY_MODAL_PREFIX}:create`)
    .setTitle("Cadastrar Hierarquia")
    .addComponents(
      modalInput("name", "Nome da hierarquia", "Exemplo: Alto Comando", true, TextInputStyle.Short, 100),
      modalInput("title", "Título do painel", "Exemplo: Hierarquia - Alto Comando", false, TextInputStyle.Short, 120),
      modalInput("description", "Descrição do painel", "Texto exibido no topo do painel", false, TextInputStyle.Paragraph, 1200),
      modalInput("channelId", "ID do canal do painel", "Cole o ID do canal ou deixe vazio", false, TextInputStyle.Short, 32),
      modalInput("color", "Cor hexadecimal", "#22c55e", false, TextInputStyle.Short, 7)
    );
}

function hierarchyNameModal(panel: FivemHierarchyPanel) {
  return new ModalBuilder()
    .setCustomId(`${HIERARCHY_MODAL_PREFIX}:edit_name:${panel.id}`)
    .setTitle("Editar Nome")
    .addComponents(modalInput("name", "Nome da hierarquia", panel.name, true, TextInputStyle.Short, 100, panel.name));
}

function hierarchyPanelModal(panel: FivemHierarchyPanel) {
  return new ModalBuilder()
    .setCustomId(`${HIERARCHY_MODAL_PREFIX}:edit_panel:${panel.id}`)
    .setTitle("Editar Painel")
    .addComponents(
      modalInput("title", "Título", "Título do painel", false, TextInputStyle.Short, 120, panel.title),
      modalInput("description", "Descrição", "Descrição do painel", false, TextInputStyle.Paragraph, 1200, panel.description ?? ""),
      modalInput("channelId", "ID do canal", "Cole o ID do canal ou deixe vazio", false, TextInputStyle.Short, 32, panel.panelChannelId ?? ""),
      modalInput("color", "Cor hexadecimal", "#22c55e", false, TextInputStyle.Short, 7, panel.color)
    );
}

function hierarchyConfigPanelPayload(panelCount: number, missingRoleLabels: string[]) {
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:create`).setEmoji("➕").setLabel("Cadastrar Hierarquia").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:add_role`).setEmoji("🎖️").setLabel("Cadastrar Cargos").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:edit_name`).setEmoji("✏️").setLabel("Editar Nome").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:edit_panel`).setEmoji("🖼️").setLabel("Editar Painel").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:refresh_all`).setEmoji("🔄").setLabel("Atualizar Painéis").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:refresh_one`).setEmoji("🔁").setLabel("Atualizar Uma").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:delete`).setEmoji("🗑️").setLabel("Excluir Hierarquia").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${HIERARCHY_CONFIG_PREFIX}:list`).setEmoji("📋").setLabel("Ver Hierarquias").setStyle(ButtonStyle.Secondary)
    )
  ];

  return renderComponentsV2Panel({
    accentColor: missingRoleLabels.length ? 0xf59e0b : 0x22c55e,
    actions: rows,
    description: [
      `Hierarquias ativas encontradas: **${panelCount}**.`,
      "Crie, edite, cadastre cargos, exclua e atualize os paineis por aqui. A dashboard usa o mesmo banco.",
      missingRoleLabels.length
        ? `\nCargos não encontrados:\n${missingRoleLabels.slice(0, 10).map((item) => `• ${item}`).join("\n")}`
        : "\nTodos os cargos cadastrados foram encontrados."
    ].join("\n"),
    moduleId: "fivem-hierarchy",
    title: "Configuração de Hierarquia"
  });
}

function buildHierarchyPanelSelect(action: string, panels: FivemHierarchyPanel[]) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${HIERARCHY_SELECT_PREFIX}:${action}`)
      .setPlaceholder("Selecione a hierarquia")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(panels.slice(0, 25).map((panel) => ({
        description: `${panel.hierarchies.length} cargo(s) | ${panel.enabled ? "ativo" : "inativo"}`.slice(0, 100),
        label: panel.name.slice(0, 100),
        value: panel.id
      })))
  );
}

function modalInput(id: string, label: string, placeholder: string, required: boolean, style: TextInputStyle, maxLength: number, value?: string) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setMaxLength(maxLength)
    .setPlaceholder(placeholder.slice(0, 100))
    .setRequired(required)
    .setStyle(style);
  if (value) input.setValue(value.slice(0, maxLength));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function readModalField(interaction: ModalSubmitInteraction, fieldId: string, maxLength: number) {
  return interaction.fields.getTextInputValue(fieldId).trim().slice(0, maxLength);
}

function normalizeModalColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#22c55e";
}

function normalizeModalSnowflake(value: string) {
  return /^\d{5,32}$/.test(value) ? value : null;
}

function getMissingHierarchyRoleIds(guild: Guild, panel: FivemHierarchyPanel) {
  const roleIds = [...new Set(panel.hierarchies.filter((item) => item.active && item.roleId).map((item) => item.roleId))];
  return roleIds.filter((roleId) => !guild.roles.cache.has(roleId));
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
  return normalized === "thumbnail" ? "side" : normalized;
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
