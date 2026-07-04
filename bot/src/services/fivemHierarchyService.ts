import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    type ButtonInteraction,
    type ChatInputCommandInteraction,
    type Client,
    type Guild,
    type GuildMember,
    type Interaction,
    type Message
} from "discord.js";
import { isBotModuleEnabled } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import type { FivemHierarchyPanel } from "./apiClient";
import { renderComponentsV2Panel, type PanelVisualConfig } from "./panelVisualRenderer";

const PREFIX = "fivem_hierarchy";
const scheduledGuilds = new Map<string, NodeJS.Timeout>();

export const hierarchyCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("hierarquia")
    .setDescription("Gerencia os paineis automaticos de hierarquia.")
    .addSubcommand((command) => command.setName("configurar").setDescription("Mostra onde configurar unidades, cargos e o painel."))
    .addSubcommand((command) => command.setName("atualizar").setDescription("Atualiza agora todos os paineis de hierarquia.")),
  moduleId: "fivem-hierarchy",
  async execute(interaction: ChatInputCommandInteraction, context: BotContext) {
    if (!interaction.guild) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Voce precisa de permissao para gerenciar o servidor.", ephemeral: true });
      return;
    }
    if (interaction.options.getSubcommand() === "configurar") {
      await interaction.reply({ content: "Configure as unidades, canais, cargos, ordem, thumbnail e rodape na aba **Hierarquia** da Dashboard.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await refreshHierarchyPanelsForGuild(interaction.guild, context);
    await interaction.editReply("Paineis de hierarquia atualizados.");
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
  if (!interaction.isButton() || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guild) return true;
  if (interaction.customId.startsWith(`${PREFIX}:ticket:`)) {
    await showTicketModeSelection(interaction);
    return true;
  }
  if (interaction.customId.startsWith(`${PREFIX}:mode:`)) {
    await createHierarchyTicket(interaction, context);
    return true;
  }
  if (interaction.customId.startsWith(`${PREFIX}:refresh:`)) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Somente a administracao pode atualizar este painel manualmente.", ephemeral: true });
      return true;
    }
    const panelId = interaction.customId.split(":")[2] ?? null;
    await interaction.deferReply({ ephemeral: true });
    await refreshHierarchyPanelsForGuild(interaction.guild, context, panelId);
    await interaction.editReply("Painel de hierarquia atualizado.");
    return true;
  }
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
  const scoped = panels.filter((panel) => panel.guildId === guild.id && (!panelId || panel.id === panelId));
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
  const fallbackVisual: PanelVisualConfig | null = panel.imageUrl ? { imageEnabled: true, imagePosition: panel.imagePosition === "bottom" ? "bottom" : panel.imagePosition, imageUrl: panel.imageUrl } : null;
  const actions = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:ticket:${panel.id}`).setLabel("Abrir ticket de hierarquia").setEmoji("🎫").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}:refresh:${panel.id}`).setEmoji("🔄").setStyle(ButtonStyle.Secondary)
    )
  ];
  return renderComponentsV2Panel({ accentColor: colorToInt(panel.color), actions, description: panel.description ?? `Lista de membros da unidade ${panel.name}`, extraImages, fields: [renderHierarchyText(guild, panel), ...(panel.footerEnabled && panel.footerText ? [panel.footerText] : [])], image: visual?.imageEnabled ? visual : fallbackVisual, moduleId: "fivem-hierarchy", title: panel.title });
}

async function showTicketModeSelection(interaction: ButtonInteraction) {
  const panelId = interaction.customId.split(":")[2] ?? "";
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:mode:normal:${panelId}`).setLabel("Modo Normal").setEmoji("👤").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:mode:anonymous:${panelId}`).setLabel("Modo Anonimo").setEmoji("🎭").setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({
    components: [{
      type: 17,
      accent_color: 0x8b5cf6,
      components: [
        { type: 10, content: "# Ticket de Hierarquia\nEscolha como deseja iniciar o atendimento." },
        buttons
      ]
    }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

async function createHierarchyTicket(interaction: ButtonInteraction, context: BotContext) {
  const [, , mode, panelId] = interaction.customId.split(":");
  const anonymous = mode === "anonymous";
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const panel = (await context.api.getActiveFivemHierarchyPanels()).find((item) => item.guildId === interaction.guildId && item.id === panelId);
  if (!panel?.ticketCategoryId) {
    await interaction.editReply("Configure a categoria de tickets de hierarquia na dashboard antes de abrir tickets.");
    return;
  }
  if (anonymous && !panel.ticketAnonymousEnabled) {
    await interaction.editReply("O modo anonimo esta desativado para este painel.");
    return;
  }
  const category = await interaction.guild!.channels.fetch(panel.ticketCategoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.editReply("A categoria de tickets configurada nao foi encontrada.");
    return;
  }
  const me = interaction.guild!.members.me ?? await interaction.guild!.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.editReply("O bot precisa da permissao Gerenciar Canais para criar tickets de hierarquia.");
    return;
  }
  const responderRoleIds = uniqueIds([...(panel.ticketResponderRoleIds ?? []), ...(panel.allowedRoleIds ?? [])]);
  const channel = await interaction.guild!.channels.create({
    name: anonymous ? `hierarquia-anon-${interaction.user.id.slice(-4)}` : `hierarquia-${safeName(interaction.user.username)}-${interaction.user.id.slice(-4)}`,
    parent: category.id,
    topic: `${PREFIX}|ticket|${anonymous ? "anonymous" : "normal"}|${panel.id}|${interaction.user.id}`.slice(0, 1024),
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: interaction.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ReadMessageHistory] }] : []),
      ...responderRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }))
    ],
    reason: `Ticket de hierarquia ${anonymous ? "anonimo" : "normal"} aberto por ${interaction.user.tag}`
  });
  await context.api.createTicket({ guildId: interaction.guild!.id, channelId: channel.id, openerId: interaction.user.id, subject: `Hierarquia - ${anonymous ? "Anonimo" : "Normal"} - ${panel.name}` }).catch(() => null);
  await context.api.postLog({ guildId: interaction.guild!.id, userId: interaction.user.id, type: "fivem.hierarchy.ticket_created", message: `Ticket de hierarquia ${anonymous ? "anonimo" : "normal"} criado.`, metadata: { anonymous, channelId: channel.id, panelId: panel.id } }).catch(() => null);
  await channel.send(createTicketIntroPayload(panel, anonymous, interaction.user.id));
  await interaction.editReply(`Ticket criado: <#${channel.id}>`);
}

export async function handleFivemHierarchyMessage(message: Message, context: BotContext) {
  if (message.author.bot || !message.guild || !message.channel || !("topic" in message.channel)) return false;
  const topic = String(message.channel.topic ?? "");
  if (!topic.startsWith(`${PREFIX}|ticket|anonymous|`)) return false;
  const [, , , panelId, openerId] = topic.split("|");
  const panel = (await context.api.getActiveFivemHierarchyPanels().catch(() => [])).find((item) => item.guildId === message.guildId && item.id === panelId);
  if (!panel?.ticketAnonymousEnabled) return false;
  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  const isOpener = message.author.id === openerId;
  const isStaff = Boolean(member?.permissions.has(PermissionFlagsBits.ManageGuild) || uniqueIds([...(panel.ticketResponderRoleIds ?? []), ...(panel.allowedRoleIds ?? [])]).some((roleId) => member?.roles.cache.has(roleId)));
  if (!isOpener && (!panel.staffAnonymousEnabled || !isStaff)) return false;
  const displayName = isOpener ? panel.anonymousUserName : panel.anonymousStaffName;
  const avatarURL = isOpener ? panel.anonymousUserAvatarUrl : panel.anonymousStaffAvatarUrl;
  const content = [
    message.content,
    ...message.stickers.map((sticker) => `[Sticker: ${sticker.name}]`),
    ...message.attachments.map((attachment) => attachment.url)
  ].filter(Boolean).join("\n") || "*Mensagem sem texto*";
  setTimeout(() => void message.delete().catch(() => null), panel.ticketMessageDeleteDelayMs ?? 500);
  await sendAnonymousRelay(message, displayName, avatarURL, content);
  await context.api.postLog({ guildId: message.guild.id, userId: message.author.id, type: "fivem.hierarchy.anonymous_message", message: "Mensagem retransmitida em ticket anonimo de hierarquia.", metadata: { attachmentCount: message.attachments.size, channelId: message.channel.id, isStaff, panelId } }).catch(() => null);
  return true;
}

function createTicketIntroPayload(panel: FivemHierarchyPanel, anonymous: boolean, openerId: string) {
  const userLine = anonymous ? "**Modo:** Anonimo\nSua identidade nao sera exibida neste canal." : `**Modo:** Normal\n**Autor:** <@${openerId}>`;
  return renderComponentsV2Panel({
    accentColor: colorToInt(panel.color),
    description: `${userLine}\n\nExplique sua solicitacao de hierarquia e aguarde a equipe responsavel.`,
    fields: [anonymous ? "Todas as mensagens deste ticket serao apagadas e reenviadas pelo bot com identidade protegida. Os registros internos ficam disponiveis apenas nos logs." : "As mensagens serao enviadas normalmente pelo seu usuario."],
    moduleId: "fivem-hierarchy",
    title: "Ticket de Hierarquia"
  });
}

async function sendAnonymousRelay(message: Message, username: string, avatarURL: string | null, content: string) {
  if (!("createWebhook" in message.channel)) {
    if ("send" in message.channel) await message.channel.send({ content: `**${username}:**\n${content}` });
    return;
  }
  const webhook = await message.channel.createWebhook({ name: username, avatar: avatarURL || undefined, reason: "Retransmissao anonima de ticket de hierarquia" }).catch(() => null);
  if (!webhook) {
    if ("send" in message.channel) await message.channel.send({ content: `**${username}:**\n${content}` });
    return;
  }
  await webhook.send({ allowedMentions: { parse: [] }, avatarURL: avatarURL || undefined, content, username }).catch(() => null);
  await webhook.delete("Webhook temporario de retransmissao anonima").catch(() => null);
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
  return panel.hierarchies
    .filter((item) => item.active)
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const members = guild.members.cache
        .filter((member: GuildMember) => member.roles.cache.has(item.roleId))
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR"))
        .map((member) => `<@${member.id}>`)
        .slice(0, item.limit ?? 50);
      const heading = [item.emoji, `**${item.name}**`].filter(Boolean).join(" ");
      return `${heading}\n${members.length ? members.join("\n") : "*Nenhum membro*"}`;
    })
    .join("\n\n")
    .slice(0, 3800) || "*Nenhuma hierarquia configurada.*";
}

function colorToInt(value: string) {
  return Number.parseInt(value.replace("#", ""), 16) || 0x22c55e;
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids.filter((id) => /^\d{5,32}$/.test(id)))];
}

function safeName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "usuario";
}
