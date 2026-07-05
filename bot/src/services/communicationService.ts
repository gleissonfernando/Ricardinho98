import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder,
  TextInputStyle, UserSelectMenuBuilder, type ChatInputCommandInteraction, type GuildMember, type Interaction, type Message
} from "discord.js";
import type { BotContext } from "../types";
import type { DmSettings, SummonsCompetence, SummonsRecord, SummonsSettings } from "./apiClient";
import { renderComponentsV2Panel, resolvePanelImageUrl } from "./panelVisualRenderer";

const DM_PREFIX = "dm_system";
const SUMMONS_PREFIX = "summons";
const SUMMONS_WEBHOOK_NAME = "Intimações Institucionais";
const ANONYMOUS_TEAM_NAME = "Human Resources - NPD";
const DISCORD_ROLE_SELECT_LIMIT = 25;
const dmSelectionSettings = new Map<string, { expiresAt: number; imageUrlOverride: string | null; imageWarning: string | null; settings: DmSettings }>();
const dmMessageDrafts = new Map<string, { expiresAt: number; imageUrlOverride: string | null; imageWarning: string | null }>();
const summonsDrafts = new Map<string, { expiresAt: number; finalCompetence?: SummonsCompetence; redirectReason?: string | null; selectedCompetence?: SummonsCompetence; targetId?: string }>();

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
  if (!canUseSummonsCommand(interaction.member as GuildMember, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return void await interaction.reply({ content: "Você não possui um cargo autorizado.", ephemeral: true });
  }
  await interaction.reply(summonsCompetenceSelectionPayload());
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
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:anonymity`).setLabel(settings.anonymityEnabled ? "Anonimato ativo" : "Anonimato inativo").setStyle(settings.anonymityEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:iab_visual`).setLabel("Visual IAB").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:test`).setLabel("Testar sistema").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:category`).setPlaceholder("Categoria dos canais").setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:logs`).setPlaceholder("Canal de logs").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:roles`).setPlaceholder("Cargos que podem criar intimações").setMinValues(0).setMaxValues(DISCORD_ROLE_SELECT_LIMIT)),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:moderators`).setPlaceholder("Cargos da Equipe IAB / moderação").setMinValues(0).setMaxValues(DISCORD_ROLE_SELECT_LIMIT))
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

export async function handleSummonsAnonymousMessage(message: Message, context: BotContext) {
  if (!message.guild || !message.guildId || message.author.bot || message.webhookId) return false;
  if (!message.channel.isTextBased() || message.channel.isDMBased()) return false;

  const record = await context.api.getSummonsByChannel(message.channel.id).catch(() => null);
  if (!record || record.status !== "active") return false;

  const settings = await context.api.getSummonsSettings(message.guildId).catch(() => null);
  if (!settings?.anonymityEnabled) return false;

  const competence = recordCompetence(record);
  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || !hasRole(member, roleIdsForCompetence(settings, competence))) return false;

  const content = message.content.trim();
  const attachments = [...message.attachments.values()].map((attachment) => attachment.url);
  const stickerText = message.stickers.size ? [...message.stickers.values()].map((sticker) => `[Sticker: ${sticker.name}]`).join("\n") : "";
  const proxiedContent = [content, stickerText].filter(Boolean).join("\n").slice(0, 2000);
  if (!proxiedContent && attachments.length === 0) return false;

  await message.delete().catch((error) => {
    console.warn("[summons] falha ao apagar mensagem original da equipe competente", {
      channelId: message.channel.id,
      error: messageOf(error),
      guildId: message.guildId,
      userId: message.author.id
    });
  });

  const webhook = await getOrCreateSummonsWebhook(message);
  await webhook.send({
    allowedMentions: { parse: [] },
    avatarURL: botAvatarUrl(message),
    content: proxiedContent || undefined,
    files: attachments,
    username: teamNameForCompetence(competence, settings)
  });

  await sendSummonsProxyLog(message, settings, record, proxiedContent, attachments.length);
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
  if (action === "select_competence" && interaction.isStringSelectMenu()) {
    if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de Intimação está desativado.", flags: MessageFlags.Ephemeral });
    if (!canUseSummonsCommand(interaction.member as GuildMember, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void await interaction.reply({ content: "Você não possui um cargo autorizado para criar intimações.", flags: MessageFlags.Ephemeral });
    }
    const selected = parseCompetence(interaction.values[0]);
    if (!selected) return void await interaction.reply({ content: "Órgão competente inválido.", flags: MessageFlags.Ephemeral });
    summonsDrafts.set(summonsDraftKey(interaction), { expiresAt: Date.now() + 10 * 60_000, selectedCompetence: selected });
    await interaction.update(summonsTargetSelectionPayload(selected));
    return;
  }
  if (action === "select_target" && interaction.isUserSelectMenu()) {
    if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de Intimação está desativado.", flags: MessageFlags.Ephemeral });
    if (!canUseSummonsCommand(interaction.member as GuildMember, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void await interaction.reply({ content: "Você não possui um cargo autorizado para criar intimações.", flags: MessageFlags.Ephemeral });
    }
    const draft = validSummonsDraft(interaction);
    if (!draft?.selectedCompetence) return void await interaction.reply({ content: "Selecione o órgão competente antes do intimado.", flags: MessageFlags.Ephemeral });
    const targetId = interaction.values[0];
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) return void await interaction.reply({ content: "Usuário não encontrado no servidor.", flags: MessageFlags.Ephemeral });
    const resolved = resolveFinalCompetence(settings, target, draft.selectedCompetence);
    summonsDrafts.set(summonsDraftKey(interaction), { ...draft, ...resolved, expiresAt: Date.now() + 10 * 60_000, targetId });
    try {
      await interaction.showModal(createSummonsMessageModal(targetId));
    } catch (error) {
      console.error("[summons] falha ao abrir modal", {
        error: messageOf(error),
        guildId: interaction.guildId
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Não foi possível abrir o modal da intimação. Verifique as configurações do sistema.",
          flags: MessageFlags.Ephemeral
        }).catch(() => undefined);
      }
    }
    return;
  }
  if (action === "create" && interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true });
    if (!settings.enabled) return void await interaction.editReply("O Sistema de Intimação está desativado.");
    if (!canUseSummonsCommand(interaction.member as GuildMember, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void await interaction.editReply("Você não possui um cargo autorizado para criar intimações.");
    }
    const targetId = snowflakeFrom(id ?? "");
    const draft = validSummonsDraft(interaction);
    if (!draft?.targetId || draft.targetId !== targetId || !draft.finalCompetence || !draft.selectedCompetence) {
      return void await interaction.editReply("Fluxo de intimação expirado. Use /intimacao novamente.");
    }
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    const displayTarget = target?.displayName ?? targetId;
    const formattedReason = [
      `**Título:** ${title}`,
      `**Descrição:** ${description}`
    ].filter(Boolean).join("\n");
    const record = await context.api.createSummons({
      guildId: interaction.guildId,
      targetId,
      requesterId: interaction.user.id,
      reason: formattedReason,
      notes: null,
      settingsSnapshot: {
        ...summonsSettingsSnapshot(settings),
        autoRedirected: Boolean(draft.redirectReason),
        finalCompetence: draft.finalCompetence,
        redirectReason: draft.redirectReason ?? null,
        selectedCompetence: draft.selectedCompetence,
        targetDisplayName: displayTarget,
        title,
        deadline: settings.defaultDeadline || null
      }
    });
    summonsDrafts.delete(summonsDraftKey(interaction));
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
    if (!canManageSummons(interaction, settings, record)) return void await interaction.reply({ content: "Você não possui permissão para atuar nesta intimação.", ephemeral: true });
    await interaction.reply({ components: [{ type: 17, accent_color: 0xef4444, components: [{ type: 10, content: "## Confirmar finalização\nO transcript será salvo e o canal será removido." }, new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:confirm:${record.id}`).setLabel("Confirmar").setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:cancel:${record.id}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary))] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }); return;
  }
  if (action === "cancel" && interaction.isButton()) return void await interaction.update({ content: "Finalização cancelada.", components: [] });
  if (action === "confirm" && interaction.isButton()) {
    const record = await context.api.getSummons(id!);
    if (!canManageSummons(interaction, settings, record)) return void await interaction.reply({ content: "Você não possui permissão para atuar nesta intimação.", ephemeral: true });
    await closeSummons(interaction, context, settings, id!);
    return;
  }
  if (action === "abort" && interaction.isButton()) {
    const record = await context.api.getSummons(id!);
    if (!canManageSummons(interaction, settings, record)) return void await interaction.reply({ content: "Você não possui permissão para atuar nesta intimação.", ephemeral: true });
    await closeSummons(interaction, context, settings, id!, "cancelada");
    return;
  }
  if (action === "start" && interaction.isButton()) {
    if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de Intimação está desativado.", flags: MessageFlags.Ephemeral });
    if (!canUseSummonsCommand(interaction.member as GuildMember, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void await interaction.reply({ content: "Você não possui um cargo autorizado.", flags: MessageFlags.Ephemeral });
    }
    await interaction.reply(summonsCompetenceSelectionPayload());
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void await interaction.reply({ content: "Você precisa de Gerenciar Servidor.", ephemeral: true });
  const dashboardPatch = async (patch: Partial<SummonsSettings>, message: string) => { await interaction.deferUpdate(); await context.api.saveSummonsSettings(interaction.guildId, patch); await interaction.editReply({ content: message, components: [] }); };
  if (action === "toggle") return dashboardPatch({ enabled: !settings.enabled }, `Sistema ${!settings.enabled ? "ativado" : "desativado"}.`);
  if (action === "anonymity") return dashboardPatch({ anonymityEnabled: !settings.anonymityEnabled }, `Anonimato da Equipe IAB ${!settings.anonymityEnabled ? "ativado" : "desativado"}.`);
  if (action === "iab_visual" && interaction.isButton()) {
    const modal = new ModalBuilder().setCustomId(`${SUMMONS_PREFIX}:save_iab_visual`).setTitle("Visual da Equipe IAB").addComponents(inputValue("avatar", "URL do avatar da Equipe IAB", settings.teamAvatarUrl ?? "", false));
    await interaction.showModal(modal);
    return;
  }
  if (action === "save_iab_visual" && interaction.isModalSubmit()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await context.api.saveSummonsSettings(interaction.guildId, { teamAvatarUrl: nullable(interaction.fields.getTextInputValue("avatar")) });
    await interaction.editReply("Visual da Equipe IAB atualizado.");
    return;
  }
  if (action === "category") return dashboardPatch({ categoryId: interaction.values[0] }, "Categoria atualizada.");
  if (action === "logs") return dashboardPatch({ logChannelId: interaction.values[0] }, "Canal de logs atualizado.");
  if (action === "roles") return dashboardPatch({ authorizedRoleIds: interaction.values }, "Cargos autorizados atualizados.");
  if (action === "moderators") return dashboardPatch({ moderatorRoleIds: interaction.values, teamRoleIds: interaction.values }, "Cargos da Equipe IAB atualizados.");
  if (action === "test") await interaction.reply({ ...summonsPanel(settings, { id: "test", targetId: interaction.user.id, requesterId: interaction.user.id, reason: "Teste do sistema", notes: null } as SummonsRecord), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

async function createSummonsChannel(interaction: any, settings: SummonsSettings, record: SummonsRecord) {
  const target = await interaction.guild.members.fetch(record.targetId);
  const competence = recordCompetence(record);
  const slug = target.displayName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || record.targetId;
  const staffRoleIds = roleIdsForCompetence(settings, competence);
  const responsibleId = recordResponsibleId(record);
  return interaction.guild.channels.create({
    name: `intimacao-${slug}`, type: ChannelType.GuildText, parent: categoryIdForCompetence(settings, competence) ?? undefined,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: record.targetId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageWebhooks] },
      ...(responsibleId ? [{ id: responsibleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }] : []),
      ...staffRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }))
    ],
    reason: `Intimação ${record.id}`
  });
}

async function closeSummons(interaction: any, context: BotContext, settings: SummonsSettings, id: string, action = "finalizada") {
  await interaction.deferUpdate();
  const record = await context.api.getSummons(id);
  const teamName = teamNameForCompetence(recordCompetence(record), settings);
  const channel = interaction.channel;
  const transcript = settings.transcriptEnabled && channel?.isTextBased() ? await makeTranscript(channel) : null;
  const deleteAt = new Date(Date.now() + settings.deleteDelaySeconds * 1000);
  const updated = await context.api.updateSummons(id, { status: "closing", transcript, closedAt: new Date().toISOString(), closedBy: interaction.user.id, deleteAt: deleteAt.toISOString() });
  await channel?.send({ components: [{ type: 17, accent_color: 0xef4444, components: [{ type: 10, content: `## Conversa ${action}\nA solicitação foi ${action} pela ${teamName}. Este canal será excluído em ${settings.deleteDelaySeconds} segundos.` }] }], flags: MessageFlags.IsComponentsV2 });
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
    .setTitle("Intimação institucional")
    .addComponents(
      input("title", "Título da intimação", "Ex: Convocação para esclarecimentos", true, false, 100),
      input("description", "Descrição do ocorrido", "Descreva o motivo da intimação...", true, true, 850)
    );
}
export function summonsPanel(settings: SummonsSettings, record: SummonsRecord) {
  const competence = recordCompetence(record);
  const teamName = teamNameForCompetence(competence, settings);
  const deadline = snapshotString(record, "deadline");
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:finish:${record.id}`).setLabel("Finalizar Intimação").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:abort:${record.id}`).setLabel("Cancelar Intimação").setStyle(ButtonStyle.Danger)
  );
  return renderComponentsV2Panel({
    accentColor: color(settings.color),
    actions: [actions],
    description: `Este canal é confidencial e destinado à conversa com ${teamName}.`,
    fields: [
      `**Intimado:** <@${record.targetId}>`,
      `**Órgão competente:** ${competenceLabel(competence)}`,
      `**Motivo:** ${record.reason}`,
      "**Status:** Aguardando resposta",
      `**Remetente:** ${teamName}`,
      `**Data de criação:** <t:${Math.floor(new Date(record.createdAt).getTime() / 1000)}:f>`,
      `**Prazo:** ${deadline ?? "Não definido"}`
    ],
    image: (settings.panelBannerUrl ?? settings.bannerUrl) ? { imageEnabled: true, imagePosition: "banner", imageUrl: resolvePanelImageUrl(settings.panelBannerUrl ?? settings.bannerUrl) } : null,
    moduleId: SUMMONS_PREFIX,
    title: "🔒 Conversa confidencial aberta"
  });
}

export function summonsDmPayload(settings: SummonsSettings, record: SummonsRecord, guildId: string, channelId: string) {
  const channelUrl = `https://discord.com/channels/${guildId}/${channelId}`;
  const competence = recordCompetence(record);
  const teamName = teamNameForCompetence(competence, settings);
  const deadline = snapshotString(record, "deadline");
  const targetName = snapshotString(record, "targetDisplayName") ?? `<@${record.targetId}>`;
  const action = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setEmoji("🔗").setLabel("Acessar conversa").setURL(channelUrl).setStyle(ButtonStyle.Link)
  );
  return renderComponentsV2Panel({
    accentColor: color(settings.color),
    actions: [action],
    description: "Você foi intimado para prestar esclarecimentos no canal indicado abaixo.",
    fields: [
      `**Intimado:** ${targetName}`,
      `**Órgão responsável:** ${teamName}`,
      `**Canal:** <#${channelId}>`,
      `**Prazo:** ${deadline ?? "Não definido"}`,
      "Acesse o canal para responder à intimação."
    ],
    image: settings.bannerUrl ? { imageEnabled: true, imagePosition: "banner", imageUrl: resolvePanelImageUrl(settings.bannerUrl) } : null,
    moduleId: `${SUMMONS_PREFIX}-dm`,
    title: "📨 Você recebeu uma intimação"
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
  const competence = recordCompetence(record);
  const logChannelId = logChannelIdForCompetence(settings, competence);
  if (!logChannelId) return;
  const channel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);
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
      components: [{ type: 10, content: `# Intimação ${action}\n**ID:** ${record.id}\n**Competência:** ${competenceLabel(competence)}\n**Intimado:** <@${record.targetId}>\n**Remetente:** ${teamNameForCompetence(competence, settings)}\n**Motivo:** ${record.reason}\n**Canal:** ${record.channelId ? `<#${record.channelId}>` : "não criado"}\n**Data:** <t:${Math.floor(new Date(record.createdAt).getTime() / 1000)}:f>\n**Status:** ${record.status}\n**DM:** ${record.dmDeliveryStatus}${record.dmDeliveryError ? ` — ${record.dmDeliveryError}` : ""}${error ? `\n**Erro:** ${error}` : ""}${transcript ? `\n\n**Transcript:**\n${transcript.slice(0, 2500)}` : ""}` }]
    }],
    flags: MessageFlags.IsComponentsV2
  }).catch((logError: unknown) => console.error("[summons] falha ao enviar log privado", {
    error: messageOf(logError),
    guildId: interaction.guildId,
    recordId: record.id
  }));
}
async function sendSummonsProxyLog(message: Message, settings: SummonsSettings, record: SummonsRecord, content: string, attachmentCount: number) {
  const logChannelId = logChannelIdForCompetence(settings, recordCompetence(record));
  if (!logChannelId || !message.guild) return;
  const channel = await message.guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  if (channel.permissionsFor(message.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    console.error("[summons] log privado de anonimato não enviado porque o canal configurado é público", {
      channelId: channel.id,
      guildId: message.guildId,
      recordId: record.id
    });
    return;
  }
  await channel.send({
    allowedMentions: { parse: [] },
    components: [{
      type: 17,
      accent_color: color(settings.color),
      components: [{
        type: 10,
        content: [
          `# Mensagem anônima - ${ANONYMOUS_TEAM_NAME}`,
          `**Intimação:** ${record.id}`,
          `**Remetente:** ${teamNameForCompetence(recordCompetence(record), settings)}`,
          `**Canal temporário:** <#${message.channel.id}>`,
          `**Intimado:** <@${record.targetId}> (${record.targetId})`,
          `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`,
          `**Anexos:** ${attachmentCount}`,
          "",
          "**Conteúdo:**",
          content || "(sem texto)"
        ].join("\n").slice(0, 3900)
      }]
    }],
    flags: MessageFlags.IsComponentsV2
  }).catch((error: unknown) => console.error("[summons] falha ao enviar log privado de anonimato", {
    error: messageOf(error),
    guildId: message.guildId,
    recordId: record.id
  }));
}
async function getOrCreateSummonsWebhook(message: Message) {
  if (!message.guild || !("fetchWebhooks" in message.channel) || !("createWebhook" in message.channel)) {
    throw new Error("Canal de intimação não suporta webhook anônimo.");
  }
  const webhooks = await message.channel.fetchWebhooks();
  const existing = webhooks.find((webhook) => webhook.owner?.id === message.client.user.id && webhook.name === SUMMONS_WEBHOOK_NAME);
  return existing ?? await message.channel.createWebhook({
    name: SUMMONS_WEBHOOK_NAME,
    reason: "Proxy anonimo da Equipe IAB"
  });
}
async function makeTranscript(channel: any) { const messages = await channel.messages.fetch({ limit: 100 }); return [...messages.values()].reverse().map((message: any) => `[${message.createdAt.toISOString()}] ${message.author.tag}: ${message.cleanContent || "(anexo/componente)"}`).join("\n").slice(0, 490000); }
function summonsCompetenceSelectionPayload() {
  return configPayload("📨 Nova intimação", [
    "Selecione o órgão competente da ocorrência."
  ], [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${SUMMONS_PREFIX}:select_competence`)
        .setPlaceholder("Selecionar órgão competente")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          { label: "IAB", value: "iab", description: "Casos comuns de competência da IAB" },
          { label: "Conselho", value: "conselho", description: "Casos de competência do Conselho" },
          { label: "High Command", value: "hcmd", description: "Casos exclusivos do High Command" },
          { label: "Comissário", value: "comissario", description: "Casos exclusivos do Comissário" }
        )
    )
  ]);
}
function summonsTargetSelectionPayload(selected: SummonsCompetence) {
  return configPayload("📨 Selecionar intimado", [
    `**Órgão selecionado:** ${competenceLabel(selected)}`,
    "Selecione o usuário envolvido. Casos contra IAB vão ao Conselho e casos contra High Command vão ao Comissário."
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
function parseCompetence(value: string | undefined): SummonsCompetence | null {
  return value === "iab" || value === "conselho" || value === "hcmd" || value === "comissario" ? value : null;
}
function competenceLabel(value: SummonsCompetence) {
  return value === "iab" ? "IAB" : value === "conselho" ? "Conselho" : value === "hcmd" ? "High Command" : "Comissário";
}
function teamNameForCompetence(_value: SummonsCompetence, _settings?: SummonsSettings) {
  return ANONYMOUS_TEAM_NAME;
}
function roleIdsForCompetence(settings: SummonsSettings, competence: SummonsCompetence) {
  if (competence === "iab") return summonsTeamRoleIds(settings);
  if (competence === "conselho") return settings.conselhoRoleIds;
  if (competence === "hcmd") return settings.hcmdRoleIds;
  return settings.comissarioRoleIds;
}
function categoryIdForCompetence(settings: SummonsSettings, competence: SummonsCompetence) {
  if (competence === "iab") return settings.iabCategoryId ?? settings.temporaryCategoryId ?? settings.categoryId;
  if (competence === "conselho") return settings.conselhoCategoryId ?? settings.temporaryCategoryId ?? settings.categoryId;
  if (competence === "hcmd") return settings.hcmdCategoryId ?? settings.temporaryCategoryId ?? settings.categoryId;
  return settings.comissarioCategoryId ?? settings.temporaryCategoryId ?? settings.categoryId;
}
function logChannelIdForCompetence(settings: SummonsSettings, competence: SummonsCompetence | null) {
  if (competence === "iab") return settings.iabLogChannelId ?? settings.privateLogChannelId ?? settings.logChannelId;
  if (competence === "conselho") return settings.conselhoLogChannelId ?? settings.privateLogChannelId ?? settings.logChannelId;
  if (competence === "hcmd") return settings.hcmdLogChannelId ?? settings.privateLogChannelId ?? settings.logChannelId;
  if (competence === "comissario") return settings.comissarioLogChannelId ?? settings.privateLogChannelId ?? settings.logChannelId;
  return settings.privateLogChannelId ?? settings.logChannelId;
}
function resolveFinalCompetence(settings: SummonsSettings, target: GuildMember, selectedCompetence: SummonsCompetence) {
  if (hasRole(target, settings.hcmdRoleIds)) return { finalCompetence: "comissario" as const, redirectReason: "Usuário intimado possui cargo High Command." };
  if (hasRole(target, summonsTeamRoleIds(settings))) return { finalCompetence: "conselho" as const, redirectReason: "Usuário intimado possui cargo IAB." };
  return { finalCompetence: selectedCompetence, redirectReason: null };
}
function summonsDraftKey(interaction: { guildId: string; user: { id: string } }) {
  return `${interaction.guildId}:${interaction.user.id}`;
}
function validSummonsDraft(interaction: { guildId: string; user: { id: string } }) {
  const draft = summonsDrafts.get(summonsDraftKey(interaction));
  if (!draft || draft.expiresAt <= Date.now()) return null;
  return draft;
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
function canManageSummons(interaction: any, settings: SummonsSettings, record?: SummonsRecord) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const competence = record ? recordCompetence(record) : null;
  return competence
    ? hasRole(interaction.member as GuildMember, roleIdsForCompetence(settings, competence))
    : hasRole(interaction.member as GuildMember, [...settings.moderatorRoleIds, ...settings.teamRoleIds]);
}
function summonsTeamRoleIds(settings: SummonsSettings) {
  const configured = [...new Set(settings.teamRoleIds.filter(Boolean))];
  return configured.length ? configured : [...new Set([...settings.authorizedRoleIds, ...settings.moderatorRoleIds])];
}
function canUseSummonsCommand(member: GuildMember, settings: SummonsSettings) {
  const roles = settings.allowedCommandRoleIds.length ? settings.allowedCommandRoleIds : settings.authorizedRoleIds;
  return roles.length > 0 && hasRole(member, roles);
}
function snapshotString(record: SummonsRecord, key: string) {
  const value = record.settingsSnapshot?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}
function recordResponsibleId(record: SummonsRecord) {
  const value = snapshotString(record, "responsibleId");
  return value && /^\d{5,32}$/.test(value) ? value : null;
}
function recordCompetence(record: SummonsRecord): SummonsCompetence {
  return parseCompetence(snapshotString(record, "finalCompetence") ?? "") ?? "iab";
}
function botAvatarUrl(message: Message) {
  return message.client.user.displayAvatarURL({ size: 128 });
}
function summonsSettingsSnapshot(settings: SummonsSettings) {
  return {
    authorizedRoleIds: settings.authorizedRoleIds,
    moderatorRoleIds: settings.moderatorRoleIds,
    anonymityEnabled: settings.anonymityEnabled,
    teamRoleIds: summonsTeamRoleIds(settings),
    teamAvatarUrl: settings.teamAvatarUrl,
    privateLogChannelId: settings.privateLogChannelId,
    publicResponsibleName: ANONYMOUS_TEAM_NAME,
    dmTitle: "📨 Você recebeu uma intimação",
    dmDescription: "Você foi intimado para prestar esclarecimentos no canal indicado abaixo.",
    dmButtonText: "🔗 Acessar conversa",
    bannerUrl: settings.bannerUrl,
    color: settings.color,
    defaultMessage: `Este canal é confidencial e destinado à conversa com ${ANONYMOUS_TEAM_NAME}.`
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
