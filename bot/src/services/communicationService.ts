import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, TextInputBuilder,
  TextInputStyle, UserSelectMenuBuilder, type ChatInputCommandInteraction, type GuildMember, type Interaction
} from "discord.js";
import type { BotContext } from "../types";
import type { DmSettings, SummonsRecord, SummonsSettings } from "./apiClient";
import { renderComponentsV2Panel, resolvePanelImageUrl } from "./panelVisualRenderer";

const DM_PREFIX = "dm_system";
const SUMMONS_PREFIX = "summons";
const SUMMONS_TEAM_NAME = "Equipe AB";
const DISCORD_ROLE_SELECT_LIMIT = 25;
const dmSelectionSettings = new Map<string, { expiresAt: number; imageUrlOverride: string | null; imageWarning: string | null; settings: DmSettings }>();
const dmMessageDrafts = new Map<string, { expiresAt: number; imageUrlOverride: string | null; imageWarning: string | null }>();

export async function showDmModal(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getDmSettings(interaction.guildId!);
  if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de DM está desativado.", flags: MessageFlags.Ephemeral });
  if (!canUseDm(interaction.member as GuildMember, settings)) {
    return void await interaction.reply({ content: "Você não tem permissão para usar este comando.", flags: MessageFlags.Ephemeral });
  }
  const override = validateImageUrl(interaction.options.getString("imagem_url"));
  dmSelectionSettings.set(`${interaction.guildId}:${interaction.user.id}`, {
    expiresAt: Date.now() + 5 * 60_000,
    imageUrlOverride: override.ok ? override.url : null,
    imageWarning: override.ok ? null : override.warning,
    settings
  });
  await interaction.reply({
    components: [{
      type: 17,
      accent_color: color(settings.color),
      components: [
        { type: 10, content: `## 📨 Enviar DM oficial\nSelecione o usuário que receberá a mensagem privada.\n\n**Equipe:** **${settings.teamName ?? "Equipe NPD"}**\n${override.warning ? `\n⚠️ **Imagem ignorada:** ${override.warning}\n` : ""}\n**Segurança:** não envie senhas, tokens ou informações confidenciais por este sistema.` },
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`${DM_PREFIX}:select_target`)
            .setPlaceholder("Pesquisar usuário do servidor")
            .setMinValues(1)
            .setMaxValues(1)
        )
      ]
    }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

export async function showDmConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getDmSettings(interaction.guildId!);
  await interaction.reply(configPayload("Sistema de DM", [
    `**Status:** ${settings.enabled ? "Ativo" : "Inativo"}`,
    `**Cargos autorizados:** ${settings.authorizedRoleIds.length || "Nenhum"}`,
    `**Canal de logs:** ${settings.logChannelId ? `<#${settings.logChannelId}>` : "Não definido"}`,
    `**Cor:** ${settings.color}`
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DM_PREFIX}:toggle`).setLabel(settings.enabled ? "Desativar" : "Ativar").setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DM_PREFIX}:test`).setLabel("Testar envio").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${DM_PREFIX}:roles`).setPlaceholder("Cargos autorizados").setMinValues(0).setMaxValues(10)),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${DM_PREFIX}:logs`).setPlaceholder("Canal de logs").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1))
  ]));
}

export async function showSummonsModal(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getSummonsSettings(interaction.guildId!);
  if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de Intimação está desativado.", ephemeral: true });
  if (!hasRole(interaction.member as GuildMember, settings.authorizedRoleIds) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return void await interaction.reply({ content: "Você não possui um cargo autorizado.", ephemeral: true });
  }
  await interaction.reply(summonsTargetSelectionPayload());
}

export async function showSummonsConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getSummonsSettings(interaction.guildId!);
  await interaction.reply(configPayload("Sistema de Intimação", [
    `**Status:** ${settings.enabled ? "Ativo" : "Inativo"}`,
    `**Categoria:** ${settings.categoryId ? `<#${settings.categoryId}>` : "Não definida"}`,
    `**Logs:** ${settings.logChannelId ? `<#${settings.logChannelId}>` : "Não definido"}`,
    `**Exclusão:** ${settings.deleteDelaySeconds}s`
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:start`).setEmoji("📨").setLabel("Iniciar conversa").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:toggle`).setLabel(settings.enabled ? "Desativar" : "Ativar").setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:test`).setLabel("Testar sistema").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:category`).setPlaceholder("Categoria dos canais").setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:logs`).setPlaceholder("Canal de logs").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:roles`).setPlaceholder("Cargos que podem criar intimações").setMinValues(0).setMaxValues(DISCORD_ROLE_SELECT_LIMIT)),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:moderators`).setPlaceholder("Cargos que gerenciam intimações").setMinValues(0).setMaxValues(DISCORD_ROLE_SELECT_LIMIT))
  ]));
}

export async function handleCommunicationInteraction(interaction: Interaction, context: BotContext) {
  if (!(interaction.isMessageComponent() || interaction.isModalSubmit())) return false;
  if (!interaction.isRepliable() || (!interaction.customId.startsWith(`${DM_PREFIX}:`) && !interaction.customId.startsWith(`${SUMMONS_PREFIX}:`))) return false;
  if (!interaction.guildId || !interaction.guild) return false;
  if (interaction.customId.startsWith(`${DM_PREFIX}:`)) await handleDm(interaction, context);
  else await handleSummons(interaction, context);
  return true;
}

async function handleDm(interaction: any, context: BotContext) {
  const [, action, id] = interaction.customId.split(":");
  let settings: DmSettings;
  let cachedSelection: { expiresAt: number; imageUrlOverride: string | null; imageWarning: string | null; settings: DmSettings } | undefined;
  if (action === "select_target" && interaction.isUserSelectMenu()) {
    const key = `${interaction.guildId}:${interaction.user.id}`;
    cachedSelection = dmSelectionSettings.get(key);
    settings = cachedSelection && cachedSelection.expiresAt > Date.now()
      ? cachedSelection.settings
      : await context.api.getDmSettings(interaction.guildId);
    dmSelectionSettings.delete(key);
  } else {
    if (action === "send" && interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    settings = await context.api.getDmSettings(interaction.guildId);
  }
  if (action === "select_target" && interaction.isUserSelectMenu()) {
    if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de DM está desativado.", flags: MessageFlags.Ephemeral });
    if (!canUseDm(interaction.member as GuildMember, settings)) return void await interaction.reply({ content: "Você não tem permissão para usar este comando.", flags: MessageFlags.Ephemeral });
    const targetId = interaction.values[0];
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) return void await interaction.reply({ content: "Usuário não encontrado no servidor.", flags: MessageFlags.Ephemeral });
    if (settings.blockBots !== false && target.user.bot) return void await interaction.reply({ content: "Não é permitido enviar DM para bots neste sistema.", flags: MessageFlags.Ephemeral });
    const draftKey = `${interaction.guildId}:${interaction.user.id}:${targetId}`;
    dmMessageDrafts.set(draftKey, {
      expiresAt: Date.now() + 10 * 60_000,
      imageUrlOverride: cachedSelection?.imageUrlOverride ?? null,
      imageWarning: cachedSelection?.imageWarning ?? null
    });
    await interaction.showModal(createDmMessageModal(settings, targetId));
    return;
  }
  if (action === "send" && interaction.isModalSubmit()) {
    if (!settings.enabled) return void await interaction.editReply("O Sistema de DM está desativado.");
    if (!canUseDm(interaction.member as GuildMember, settings)) return void await interaction.editReply("Você não tem permissão para usar este comando.");
    const targetId = snowflakeFrom(id ?? "");
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    if (!title) return void await interaction.editReply("O título não pode ficar vazio.");
    if (!description) return void await interaction.editReply("A descrição não pode ficar vazia.");
    if (title.length > 60) return void await interaction.editReply("O título deve ter no máximo 60 caracteres.");
    if (description.length > 300) return void await interaction.editReply("A mensagem deve ter no máximo 300 caracteres.");
    const draftKey = `${interaction.guildId}:${interaction.user.id}:${targetId}`;
    const draft = dmMessageDrafts.get(draftKey);
    dmMessageDrafts.delete(draftKey);
    const imageOverride = draft && draft.expiresAt > Date.now() ? draft.imageUrlOverride : null;
    const draftWarning = draft && draft.expiresAt > Date.now() ? draft.imageWarning : null;
    const built = buildDmPayload(settings, title, description, interaction.guild.name, imageOverride);
    let status: "sent" | "failed" = "sent"; let error: string | null = null; let imageUsed = built.imageUsed; let imageWarning = draftWarning ?? built.imageWarning;
    try {
      const member = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (!member) throw new Error("Usuário não encontrado.");
      if (settings.blockBots !== false && member.user.bot) throw new Error("Envio para bot bloqueado.");
      const user = await context.client.users.fetch(targetId);
      await user.send(built.payload).catch(async (sendError: unknown) => {
        if (!imageUsed || !isImageDeliveryError(sendError)) throw sendError;
        imageUsed = false;
        imageWarning = "A imagem configurada não carregou no Discord; a DM foi reenviada sem imagem.";
        await user.send(buildDmPayload(settings, title, description, interaction.guild.name, null, true).payload);
      });
    } catch (caught) { status = "failed"; error = dmErrorMessage(caught); }
    await context.api.recordDm({ guildId: interaction.guildId, senderId: interaction.user.id, targetId, title, description: settings.saveContentInLogs ? description : "", hasImage: imageUsed, button: null, status, error }).catch((logError: unknown) => {
      console.error("[dm-system] falha ao persistir log de DM", {
        error: messageOf(logError),
        guildId: interaction.guildId,
        senderId: interaction.user.id,
        status,
        targetId
      });
    });
    await sendDmLog(interaction, settings, targetId, title, description, imageUsed, status, error);
    await interaction.editReply(status === "sent"
      ? `Mensagem enviada com sucesso para <@${targetId}>.${imageWarning ? `\n${imageWarning}` : ""}`
      : error === "DM fechada"
        ? "Não foi possível enviar a DM. O usuário pode estar com mensagens privadas desativadas."
        : `Não foi possível enviar a mensagem: ${error}`);
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void await interaction.reply({ content: "Você precisa de Gerenciar Servidor.", ephemeral: true });
  if (action === "toggle" && interaction.isButton()) {
    await interaction.deferUpdate(); await context.api.saveDmSettings(interaction.guildId, { enabled: !settings.enabled }); await interaction.editReply({ content: `Sistema ${!settings.enabled ? "ativado" : "desativado"}.`, components: [] }); return;
  }
  if (action === "roles" && interaction.isRoleSelectMenu()) { await interaction.deferUpdate(); await context.api.saveDmSettings(interaction.guildId, { authorizedRoleIds: interaction.values }); await interaction.editReply({ content: "Cargos atualizados.", components: [] }); return; }
  if (action === "logs" && interaction.isChannelSelectMenu()) { await interaction.deferUpdate(); await context.api.saveDmSettings(interaction.guildId, { logChannelId: interaction.values[0] }); await interaction.editReply({ content: "Canal de logs atualizado.", components: [] }); return; }
  if (action === "visual" && interaction.isButton()) {
    const modal = new ModalBuilder().setCustomId(`${DM_PREFIX}:save_visual`).setTitle("Visual da DM").addComponents(inputValue("color", "Cor hexadecimal", settings.color, true), inputValue("title", "Título padrão", settings.defaultTitle, true), inputValue("text", "Texto padrão", settings.defaultText, true, true), inputValue("footer", "Rodapé", settings.footerText ?? "", false), inputValue("banner", "URL do banner", settings.bannerUrl ?? "", false));
    await interaction.showModal(modal); return;
  }
  if (action === "save_visual" && interaction.isModalSubmit()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await context.api.saveDmSettings(interaction.guildId, { color: normalizedColor(interaction.fields.getTextInputValue("color")), defaultTitle: interaction.fields.getTextInputValue("title"), defaultText: interaction.fields.getTextInputValue("text"), footerText: nullable(interaction.fields.getTextInputValue("footer")), bannerUrl: nullable(interaction.fields.getTextInputValue("banner")) }); await interaction.editReply("Visual atualizado."); return;
  }
  if (action === "test" && interaction.isButton()) { await interaction.reply({ ...dmPayload(settings, settings.defaultTitle, settings.defaultText, interaction.guild.name), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }); }
}

async function handleSummons(interaction: any, context: BotContext) {
  const [action, id] = interaction.customId.split(":").slice(1);
  const settings = await context.api.getSummonsSettings(interaction.guildId);
  if (action === "select_target" && interaction.isUserSelectMenu()) {
    if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de Intimação está desativado.", flags: MessageFlags.Ephemeral });
    if (!hasRole(interaction.member as GuildMember, settings.authorizedRoleIds) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void await interaction.reply({ content: "Você não possui um cargo autorizado para criar intimações.", flags: MessageFlags.Ephemeral });
    }
    const targetId = interaction.values[0];
    await interaction.showModal(createSummonsMessageModal(targetId));
    return;
  }
  if (action === "create" && interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true });
    if (!settings.enabled) return void await interaction.editReply("O Sistema de Intimação está desativado.");
    if (!hasRole(interaction.member as GuildMember, settings.authorizedRoleIds) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void await interaction.editReply("Você não possui um cargo autorizado para criar intimações.");
    }
    const targetId = snowflakeFrom(id ?? "");
    const record = await context.api.createSummons({
      guildId: interaction.guildId,
      targetId,
      requesterId: interaction.user.id,
      reason: interaction.fields.getTextInputValue("description"),
      notes: null,
      settingsSnapshot: summonsSettingsSnapshot(settings)
    });
    try {
      const channel = await createSummonsChannel(interaction, settings, record);
      const panel = await channel.send(summonsPanel(settings, record));
      let dmMessageId: string | null = null;
      let dmDeliveryStatus: "sent" | "failed" = "sent";
      let dmDeliveryError: string | null = null;
      try {
        const target = await context.client.users.fetch(targetId);
        const dm = await target.send(summonsDmPayload(settings, record, interaction.guild.id, channel.id));
        dmMessageId = dm.id;
      } catch (dmError) {
        dmDeliveryStatus = "failed";
        dmDeliveryError = messageOf(dmError);
      }
      const saved = await context.api.updateSummons(record.id, { channelId: channel.id, panelMessageId: panel.id, dmMessageId, dmDeliveryStatus, dmDeliveryError, status: "active" });
      await replaceDeferredWithComponents(interaction, summonsCreatedConfirmation(saved));
      await sendSummonsLog(interaction, settings, saved, "criada");
    } catch (error) {
      const failed = await context.api.updateSummons(record.id, { status: "failed" });
      await replaceDeferredWithComponents(interaction, summonsFailureConfirmation(failed, messageOf(error)));
      await sendSummonsLog(interaction, settings, failed, "falhou", null, messageOf(error));
    }
    return;
  }
  if (action === "finish" && interaction.isButton()) {
    const record = await context.api.getSummons(id!);
    if (!canManageSummons(interaction, settings)) return void await interaction.reply({ content: "Você não possui um cargo autorizado para gerenciar intimações.", ephemeral: true });
    await interaction.reply({ components: [{ type: 17, accent_color: 0xef4444, components: [{ type: 10, content: "## Confirmar finalização\nO transcript será salvo e o canal será removido." }, new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:confirm:${record.id}`).setLabel("Confirmar").setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:cancel:${record.id}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary))] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }); return;
  }
  if (action === "cancel" && interaction.isButton()) return void await interaction.update({ content: "Finalização cancelada.", components: [] });
  if (action === "confirm" && interaction.isButton()) {
    if (!canManageSummons(interaction, settings)) return void await interaction.reply({ content: "Você não possui um cargo autorizado para finalizar intimações.", ephemeral: true });
    await closeSummons(interaction, context, settings, id!);
    return;
  }
  if (action === "abort" && interaction.isButton()) {
    if (!canManageSummons(interaction, settings)) return void await interaction.reply({ content: "Você não possui um cargo autorizado para cancelar intimações.", ephemeral: true });
    await closeSummons(interaction, context, settings, id!, "cancelada");
    return;
  }
  if (action === "start" && interaction.isButton()) {
    if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de Intimação está desativado.", flags: MessageFlags.Ephemeral });
    if (!hasRole(interaction.member as GuildMember, settings.authorizedRoleIds) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void await interaction.reply({ content: "Você não possui um cargo autorizado.", flags: MessageFlags.Ephemeral });
    }
    await interaction.reply(summonsTargetSelectionPayload());
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void await interaction.reply({ content: "Você precisa de Gerenciar Servidor.", ephemeral: true });
  const dashboardPatch = async (patch: Partial<SummonsSettings>, message: string) => { await interaction.deferUpdate(); await context.api.saveSummonsSettings(interaction.guildId, patch); await interaction.editReply({ content: message, components: [] }); };
  if (action === "toggle") return dashboardPatch({ enabled: !settings.enabled }, `Sistema ${!settings.enabled ? "ativado" : "desativado"}.`);
  if (action === "category") return dashboardPatch({ categoryId: interaction.values[0] }, "Categoria atualizada.");
  if (action === "logs") return dashboardPatch({ logChannelId: interaction.values[0] }, "Canal de logs atualizado.");
  if (action === "roles") return dashboardPatch({ authorizedRoleIds: interaction.values }, "Cargos autorizados atualizados.");
  if (action === "moderators") return dashboardPatch({ moderatorRoleIds: interaction.values }, "Cargos de moderação atualizados.");
  if (action === "test") await interaction.reply({ ...summonsPanel(settings, { id: "test", targetId: interaction.user.id, requesterId: interaction.user.id, reason: "Teste do sistema", notes: null } as SummonsRecord), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

async function createSummonsChannel(interaction: any, settings: SummonsSettings, record: SummonsRecord) {
  const target = await interaction.guild.members.fetch(record.targetId);
  const slug = target.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 50) || record.targetId;
  const staffRoleIds = [...new Set([...settings.authorizedRoleIds, ...settings.moderatorRoleIds])];
  return interaction.guild.channels.create({
    name: `intimacao-${slug}`, type: ChannelType.GuildText, parent: settings.temporaryCategoryId ?? settings.categoryId ?? undefined,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: record.targetId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
      ...staffRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }))
    ],
    reason: `Intimação ${record.id}`
  });
}

async function closeSummons(interaction: any, context: BotContext, settings: SummonsSettings, id: string, action = "finalizada") {
  await interaction.deferUpdate();
  const record = await context.api.getSummons(id);
  const channel = interaction.channel;
  const transcript = settings.transcriptEnabled && channel?.isTextBased() ? await makeTranscript(channel) : null;
  const deleteAt = new Date(Date.now() + settings.deleteDelaySeconds * 1000);
  const updated = await context.api.updateSummons(id, { status: "closing", transcript, closedAt: new Date().toISOString(), closedBy: interaction.user.id, deleteAt: deleteAt.toISOString() });
  await channel?.send({ components: [{ type: 17, accent_color: 0xef4444, components: [{ type: 10, content: `## Conversa ${action}\nA solicitação foi ${action} pela Equipe AB. Este canal será excluído em ${settings.deleteDelaySeconds} segundos.` }] }], flags: MessageFlags.IsComponentsV2 });
  await sendSummonsLog(interaction, settings, updated, action, transcript);
  setTimeout(() => void channel?.delete(`Intimação ${id} finalizada`).then(() => context.api.updateSummons(id, { status: "closed" })).catch(() => undefined), settings.deleteDelaySeconds * 1000).unref();
}

export function dmPayload(settings: DmSettings, title: string, description: string, guildName: string) {
  return buildDmPayload(settings, title, description, guildName).payload;
}

function buildDmPayload(settings: DmSettings, title: string, description: string, guildName: string, imageUrlOverride: string | null = null, skipConfiguredImage = false) {
  const configuredImage = skipConfiguredImage ? null : settings.imageUrl ?? settings.bannerUrl;
  const imageCandidate = imageUrlOverride ?? configuredImage;
  const imagePosition = normalizeDmImagePosition(settings.imagePosition);
  const validImage = imagePosition === "none" ? { ok: true as const, url: null, warning: null } : validateImageUrl(imageCandidate);
  const imageUrl = validImage.ok && validImage.url ? resolvePanelImageUrl(validImage.url) : null;
  const teamName = settings.teamName?.trim() || `Equipe ${guildName}`;
  const payload = renderComponentsV2Panel({
    accentColor: color(settings.color),
    description: "",
    fields: [
      `**Título:**\n**${title}**`,
      "━━━━━━━━━━━━━━━━━━━━",
      `**Mensagem:**\n**${description}**`
    ],
    footerText: `Enviado por: **${teamName}**${settings.footerText ? `\n${settings.footerText}` : ""}`,
    image: imageUrl ? { imageEnabled: true, imagePosition, imageUrl } : null,
    moduleId: "dm-system",
    title: "📨 Mensagem da equipe"
  });
  return { payload, imageUsed: Boolean(imageUrl), imageWarning: validImage.ok ? null : validImage.warning };
}

function normalizeDmImagePosition(position: DmSettings["imagePosition"]) {
  if (position === "thumbnail") return "thumbnail";
  if (position === "banner" || position === "top" || position === "footer" || position === "side") return "banner";
  return "none";
}

function validateImageUrl(value: string | null | undefined): { ok: true; url: string | null; warning: null } | { ok: false; url: null; warning: string } {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: true, url: null, warning: null };
  if (trimmed.startsWith("/")) return { ok: true, url: trimmed, warning: null };
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, url: null, warning: "use uma URL http/https válida." };
    const path = parsed.pathname.toLowerCase();
    if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return { ok: false, url: null, warning: "a URL precisa terminar em png, jpg, jpeg, gif ou webp." };
    return { ok: true, url: trimmed, warning: null };
  } catch {
    return { ok: false, url: null, warning: "URL de imagem inválida." };
  }
}

function isImageDeliveryError(error: unknown) {
  const message = messageOf(error);
  return /image|embed|invalid form body|url|400/i.test(message);
}

export function createDmMessageModal(settings: DmSettings, targetId: string) {
  return new ModalBuilder()
    .setCustomId(`${DM_PREFIX}:send:${targetId}`)
    .setTitle("Enviar mensagem privada")
    .addComponents(
      inputValue("title", "Título da mensagem", settings.defaultTitle, true, false, 60),
      inputValue("description", "Mensagem", settings.defaultText, true, true, 300)
    );
}

export function createSummonsMessageModal(targetId: string) {
  return new ModalBuilder()
    .setCustomId(`${SUMMONS_PREFIX}:create:${targetId}`)
    .setTitle("Conversa da Equipe AB")
    .addComponents(input("description", "Descrição da mensagem", "Descreva o motivo da conversa", true, true, 1000));
}
export function summonsPanel(settings: SummonsSettings, record: SummonsRecord) {
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:finish:${record.id}`).setLabel("Finalizar Intimação").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:abort:${record.id}`).setLabel("Cancelar Intimação").setStyle(ButtonStyle.Danger)
  );
  return renderComponentsV2Panel({
    accentColor: color(settings.color),
    actions: [actions],
    description: "Este canal é confidencial e destinado à conversa com a Equipe AB.",
    fields: [
      `**Intimado:** <@${record.targetId}>`,
      `**Motivo:** ${record.reason}`,
      "**Status:** Aguardando resposta",
      `**Responsável:** ${SUMMONS_TEAM_NAME}`,
      ...(record.notes ? [`**Observações:** ${record.notes}`] : [])
    ],
    image: settings.bannerUrl ? { imageEnabled: true, imagePosition: "banner", imageUrl: resolvePanelImageUrl(settings.bannerUrl) } : null,
    moduleId: SUMMONS_PREFIX,
    title: "🔒 Conversa confidencial aberta"
  });
}

export function summonsDmPayload(settings: SummonsSettings, record: SummonsRecord, guildId: string, channelId: string) {
  const channelUrl = `https://discord.com/channels/${guildId}/${channelId}`;
  const action = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setEmoji("🔗").setLabel("Acessar conversa").setURL(channelUrl).setStyle(ButtonStyle.Link)
  );
  return renderComponentsV2Panel({
    accentColor: color(settings.color),
    actions: [action],
    description: "A Equipe AB está solicitando sua presença para uma conversa.",
    fields: [
      `**Mensagem:**\n${record.reason}`,
      "**Canal:** Acesse o canal abaixo para continuar o atendimento.",
      `**Canal:** <#${channelId}>`,
      `**Equipe:** ${SUMMONS_TEAM_NAME}`
    ],
    image: settings.bannerUrl ? { imageEnabled: true, imagePosition: "banner", imageUrl: resolvePanelImageUrl(settings.bannerUrl) } : null,
    moduleId: `${SUMMONS_PREFIX}-dm`,
    title: "📨 Solicitação da Equipe AB"
  });
}

function summonsCreatedConfirmation(record: SummonsRecord) {
  return {
    components: [{
      type: 17,
      accent_color: 0x22c55e,
      components: [{
        type: 10,
        content: `# Intimação criada\n**ID da intimação:** ${record.id}\n**Intimado:** <@${record.targetId}>\n**Canal temporário:** ${record.channelId ? `<#${record.channelId}>` : "indisponível"}\n**Status:** ativa\n**DM:** ${record.dmDeliveryStatus === "sent" ? "enviada" : "falhou"}`
      }]
    }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  };
}

function summonsFailureConfirmation(record: SummonsRecord, error: string) {
  return {
    components: [{
      type: 17,
      accent_color: 0xef4444,
      components: [{ type: 10, content: `# Falha ao criar intimação\n**ID:** ${record.id}\n**Status:** falhou\n**Motivo:** ${error}` }]
    }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  };
}

async function replaceDeferredWithComponents(interaction: any, payload: any) {
  await interaction.deleteReply().catch(() => undefined);
  await interaction.followUp(payload).catch(async () => {
    await interaction.editReply({ content: "A operação foi concluída, mas não foi possível renderizar a confirmação.", components: [] }).catch(() => undefined);
  });
}
async function sendDmLog(interaction: any, settings: DmSettings, targetId: string, title: string, description: string, hasImage: boolean, status: string, error: string | null) {
  if (!settings.logChannelId) return;
  const channel = await interaction.guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (channel?.isTextBased() && !channel.isDMBased()) await channel.send({
    components: [{
      type: 17,
      accent_color: status === "sent" ? 0x22c55e : 0xef4444,
      components: [{ type: 10, content: `## 📨 Log de DM\n**Quem enviou:** <@${interaction.user.id}>\n**Quem recebeu:** <@${targetId}>\n**Título enviado:** ${title}\n**Tinha imagem:** ${hasImage ? "Sim" : "Não"}\n**Servidor:** ${interaction.guild.name}\n**Status:** ${status === "sent" ? "enviada" : "falhou"}\n**Data e horário:** <t:${Math.floor(Date.now() / 1000)}:f>${settings.saveContentInLogs ? `\n\n**Conteúdo da DM:**\n${description}` : ""}${error ? `\n**Motivo:** ${error}` : ""}` }]
    }],
    flags: MessageFlags.IsComponentsV2
  }).catch((logError: unknown) => {
    console.error("[dm-system] falha ao enviar log no canal configurado", {
      channelId: settings.logChannelId,
      error: messageOf(logError),
      guildId: interaction.guildId,
      status,
      targetId
    });
  });
}
async function sendSummonsLog(interaction: any, settings: SummonsSettings, record: SummonsRecord, action: string, transcript?: string | null, error?: string | null) {
  if (!settings.logChannelId) return;
  const channel = await interaction.guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  if (channel.permissionsFor(interaction.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    console.error("[summons] log privado não enviado porque o canal configurado é público", {
      channelId: channel.id,
      guildId: interaction.guildId,
      recordId: record.id
    });
    return;
  }
  await channel.send({
    components: [{
      type: 17,
      accent_color: color(settings.color),
      components: [{ type: 10, content: `# Intimação ${action}\n**ID:** ${record.id}\n**Intimado:** <@${record.targetId}>\n**Criado por:** <@${record.requesterId}>\n**Motivo:** ${record.reason}\n**Canal:** ${record.channelId ? `<#${record.channelId}>` : "não criado"}\n**Data:** <t:${Math.floor(new Date(record.createdAt).getTime() / 1000)}:f>\n**Status:** ${record.status}\n**DM:** ${record.dmDeliveryStatus}${record.dmDeliveryError ? ` — ${record.dmDeliveryError}` : ""}${error ? `\n**Erro:** ${error}` : ""}${transcript ? `\n\n**Transcript:**\n${transcript.slice(0, 2500)}` : ""}` }]
    }],
    flags: MessageFlags.IsComponentsV2
  }).catch((logError: unknown) => console.error("[summons] falha ao enviar log privado", {
    error: messageOf(logError),
    guildId: interaction.guildId,
    recordId: record.id
  }));
}
async function makeTranscript(channel: any) { const messages = await channel.messages.fetch({ limit: 100 }); return [...messages.values()].reverse().map((message: any) => `[${message.createdAt.toISOString()}] ${message.author.tag}: ${message.cleanContent || "(anexo/componente)"}`).join("\n").slice(0, 490000); }
function summonsTargetSelectionPayload() {
  return configPayload("📨 Iniciar conversa da Equipe AB", [
    "Selecione o usuário que receberá a solicitação confidencial."
  ], [
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`${SUMMONS_PREFIX}:select_target`)
        .setPlaceholder("Pesquisar usuário")
        .setMinValues(1)
        .setMaxValues(1)
    )
  ]);
}
function configPayload(title: string, lines: string[], rows: any[]) { return { components: [{ type: 17, accent_color: 0x5865f2, components: [{ type: 10, content: `# ${title}\n${lines.join("\n")}` }, ...rows] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }; }
function input(id: string, label: string, placeholder: string, required: boolean, paragraph = false, maxLength = paragraph ? 4000 : 1000) { return new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder.slice(0, 100)).setRequired(required).setMaxLength(maxLength).setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)); }
function inputValue(id: string, label: string, value: string, required: boolean, paragraph = false, maxLength = paragraph ? 4000 : 1000) {
  const field = new TextInputBuilder().setCustomId(id).setLabel(label).setRequired(required).setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short);
  field.setMaxLength(maxLength);
  if (value) field.setValue(value.slice(0, maxLength));
  else field.setPlaceholder(label.slice(0, 100));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
}
function hasRole(member: GuildMember, roles: string[]) { return roles.some((id) => member.roles.cache.has(id)); }
function canUseDm(member: GuildMember, settings: DmSettings) { return settings.authorizedRoleIds.length > 0 && hasRole(member, settings.authorizedRoleIds); }
function canManageSummons(interaction: any, settings: SummonsSettings) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    || hasRole(interaction.member as GuildMember, settings.moderatorRoleIds);
}
function summonsSettingsSnapshot(settings: SummonsSettings) {
  return {
    authorizedRoleIds: settings.authorizedRoleIds,
    moderatorRoleIds: settings.moderatorRoleIds,
    publicResponsibleName: SUMMONS_TEAM_NAME,
    dmTitle: "📨 Solicitação da Equipe AB",
    dmDescription: "A Equipe AB está solicitando sua presença para uma conversa.",
    dmButtonText: "🔗 Acessar conversa",
    bannerUrl: settings.bannerUrl,
    color: settings.color,
    defaultMessage: "Este canal é confidencial e destinado à conversa com a Equipe AB."
  };
}
function snowflakeFrom(value: string) { const match = value.match(/\d{5,32}/); if (!match) throw new Error("Informe um ID ou menção válida."); return match[0]; }
function normalizedColor(value: string) { return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : "#5865f2"; }
function nullable(value: string) { return value.trim() || null; }
function color(value: string) { return Number.parseInt(value.replace("#", ""), 16) || 0x5865f2; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function dmErrorMessage(error: unknown) {
  const message = messageOf(error);
  if (/cannot send messages|50007|dm/i.test(message)) return "DM fechada";
  if (/not found|unknown user|usuário não encontrado/i.test(message)) return "Usuário não encontrado";
  if (/permission|missing access|bloqueado/i.test(message)) return "Permissão insuficiente";
  return message || "Erro interno";
}
