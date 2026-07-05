import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
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
const autoRefreshTimers = new Map<string, NodeJS.Timeout>();
const publishingPanels = new Map<string, Promise<void>>();
const HIERARCHY_REFRESH_PREFIX = "fivem_hierarchy:refresh";
let hierarchyRuntime: { client: Client<true>; context: BotContext } | null = null;

type HierarchyRefreshOptions = {
  allowCreate?: boolean;
  actorId?: string | null;
  automatic?: boolean;
};

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
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "config" || subcommand === "configurar" || subcommand === "resetar") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: "Voce precisa de permissao para gerenciar o servidor.", ephemeral: true });
        return;
      }
      const [panels, roles] = await Promise.all([loadActiveHierarchyPanels(context), interaction.guild.roles.fetch()]);
      const missing = panels
        .filter((panel) => panel.guildId === interaction.guild!.id)
        .flatMap((panel) => panel.hierarchies
          .filter((item) => item.roleId && !roles.has(item.roleId))
          .map((item) => `${panel.name}: ${item.name} (${item.roleId})`));
      await interaction.reply({
        content: `Configure as hierarquias, cargos/patentes, ordem, imagens, texto, rodape e canal na aba **Hierarquia** da Dashboard.${missing.length ? `\n\n⚠️ **Cargos não encontrados:**\n${missing.slice(0, 20).join("\n")}` : "\n\n✅ Todos os cargos cadastrados foram encontrados."}`,
        ephemeral: true
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const unit = interaction.options.getString("unidade")?.trim().toLowerCase() ?? null;
    const syncAll = subcommand === "sync" || subcommand === "atualizar_todas";
    if (syncAll && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply("Voce precisa de permissao para gerenciar o servidor.");
      return;
    }
    const selectedPanel = syncAll ? null : await findHierarchyPanel(interaction.guild.id, context, unit);
    if (!syncAll && (!selectedPanel || !canEditHierarchyPanel(interaction.member as GuildMember, selectedPanel, interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true))) {
      await interaction.editReply("Voce nao possui permissao para editar esta hierarquia.");
      return;
    }
    if (subcommand === "preview") {
      const panel = selectedPanel;
      if (!panel) {
        await interaction.editReply("Unidade de hierarquia nao encontrada ou desativada.");
        return;
      }
      const members = await fetchHierarchyMembers(interaction.guild);
      await interaction.editReply(createHierarchyPayload(interaction.guild, panel, panel.imageUrl ? { imageEnabled: true, imagePosition: panel.imagePosition === "thumbnail" ? "side" : panel.imagePosition, imageUrl: panel.imageUrl } : null, [], members));
      return;
    }
    await refreshHierarchyPanelsForGuild(interaction.guild, context, syncAll ? null : unit, {
      actorId: interaction.user.id,
      allowCreate: true
    });
    await interaction.editReply(syncAll ? "Todos os paineis de hierarquia foram atualizados." : "Painel de hierarquia atualizado.");
  }
};

export function startFivemHierarchyService(client: Client<true>, context: BotContext) {
  hierarchyRuntime = { client, context };

  context.socket.onFivemHierarchyPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    if (payload.action === "publish") {
      void refreshHierarchyPanelsForGuild(guild, context, payload.panelId, { allowCreate: true, automatic: false });
      void reconcileHierarchyAutoRefreshTimers(client, context, guild.id);
      return;
    }

    scheduleHierarchyRefresh(guild, context, payload.panelId, { allowCreate: true, automatic: false });
    void reconcileHierarchyAutoRefreshTimers(client, context, guild.id);
  });

  for (const guild of client.guilds.cache.values()) {
    scheduleHierarchyRefresh(guild, context, null, { allowCreate: true });
  }
  void reconcileHierarchyAutoRefreshTimers(client, context);
}

export async function handleFivemHierarchyInteraction(interaction: Interaction, context: BotContext) {
  if (!interaction.isButton() || !interaction.customId.startsWith(`${HIERARCHY_REFRESH_PREFIX}:`) || !interaction.guild) {
    return false;
  }

  await handleHierarchyRefreshButton(interaction, context);
  return true;
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
  console.log(`[HIERARQUIA] Alteracao relevante detectada para ${newMember.user.tag}. Sincronizando os paineis do servidor.`);
  scheduleHierarchyRefresh(newMember.guild, context);
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
  const channel = await guild.channels.fetch(panel.panelChannelId).catch(() => null);
  if (!channel || !("send" in channel) || !("messages" in channel)) return;
  const visuals = await getPanelVisualSlots(context, guild.id, panel.id);
  const payload = createHierarchyPayload(guild, panel, visuals[0] ?? null, visuals.slice(1), members);
  let message = panel.panelMessageId ? await channel.messages.fetch(panel.panelMessageId).catch(() => null) : null;
  if (message) {
    await message.edit(payload);
  } else if (!allowCreate) {
    console.log(`[HIERARQUIA] Painel ${panel.name} sem mensagem salva/encontrada. Atualizacao automatica nao criou painel novo.`);
    return;
  } else {
    message = await channel.send(payload).catch(() => null);
  }
  if (message) {
    await context.api.updateFivemHierarchyPanelState({ guildId: guild.id, messageId: message.id, panelId: panel.id }).catch(() => null);
  }
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
  const panelIds = getHierarchyPanelVisualIds(basePanelId);
  const visuals = await Promise.all(panelIds.map((panelId) => context.api.getPanelVisualSettings(guildId, panelId).catch(() => null)));

  return visuals.flatMap((visual, index): PanelVisualConfig[] => {
    if (!visual?.imageEnabled) return [];
    if (index > 0 && visual.useGlobalDefault) return [];
    return [{ imageEnabled: visual.imageEnabled, imagePosition: visual.imagePosition, imageUrl: visual.imageUrl }];
  });
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
  const seenInBlock = new Set<string>();
  const members = getHierarchyMemberCache(memberSource);

  for (const block of panel.hierarchies.filter((item) => item.active)) {
    if (!block.roleId) continue;

    const membersWithRole = members.filter((member) => member.roles.cache.has(block.roleId) && !member.user?.bot);
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

type HierarchyMemberCache = {
  filter(predicate: (member: GuildMember) => boolean): { values(): IterableIterator<GuildMember> };
};

type HierarchyMemberSource = Pick<Guild, "members"> | HierarchyMemberCache;

async function fetchHierarchyMembers(guild: Guild): Promise<HierarchyMemberCache> {
  try {
    await guild.roles.fetch();
    return await guild.members.fetch();
  } catch (error) {
    console.error(`[HIERARQUIA] Falha ao buscar membros atualizados do servidor ${guild.id}. Verifique SERVER MEMBERS INTENT no Developer Portal.`, error);
    return guild.members.cache;
  }
}

function getHierarchyMemberCache(source: HierarchyMemberSource): HierarchyMemberCache {
  return "members" in source ? source.members.cache : source;
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

    const intervalMs = normalizeAutoUpdateIntervalSeconds(panel.autoUpdateIntervalSeconds) * 1000;
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

function normalizeAutoUpdateIntervalSeconds(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 300;
  return Math.max(30, Math.min(86_400, Math.trunc(value)));
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
