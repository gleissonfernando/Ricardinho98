import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Interaction
} from "discord.js";
import type { BotCommand, BotContext } from "../types";
import type { OpenPointCounter, OpenPointSettings } from "./apiClient";
import { renderComponentsV2Panel, resolvePanelImageUrl } from "./panelVisualRenderer";

const MODULE_ID = "open-point-notification";
const PREFIX = "open_point";
const THRESHOLD = 3;
type FineStatus = "not_needed" | "sent" | "missing_channel" | "failed";

export const notifyOpenPointCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("notificar")
    .setDescription("Notifica um membro sobre ponto de serviço aberto.")
    .addUserOption((option) => option.setName("usuario").setDescription("Membro que esqueceu o ponto aberto.").setRequired(true)),
  moduleId: MODULE_ID,
  async execute(interaction, context) {
    await handleNotifyCommand(interaction, context);
  }
};

export const notifyOpenPointCounterCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("notificar-contador")
    .setDescription("Consulta o contador de notificações de ponto aberto.")
    .addUserOption((option) => option.setName("usuario").setDescription("Membro consultado.").setRequired(true)),
  moduleId: MODULE_ID,
  async execute(interaction, context) {
    await handleCounterCommand(interaction, context);
  }
};

export const notifyOpenPointResetCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("notificar-reset")
    .setDescription("Reseta o contador de notificações de ponto aberto.")
    .addUserOption((option) => option.setName("usuario").setDescription("Membro que terá o contador resetado.").setRequired(true)),
  moduleId: MODULE_ID,
  async execute(interaction, context) {
    await handleResetCommand(interaction, context);
  }
};

export const notifyOpenPointConfigCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("notificar-config")
    .setDescription("Configura o sistema de notificação de ponto aberto."),
  moduleId: MODULE_ID,
  async execute(interaction, context) {
    await handleConfigCommand(interaction, context);
  }
};

async function handleNotifyCommand(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return void await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
  const settings = await context.api.getOpenPointSettings(interaction.guild.id);
  if (!settings.enabled) return void await interaction.reply({ content: "O sistema de Notificação de Ponto Aberto está desativado.", ephemeral: true });
  if (!(await canUseOpenPoint(interaction, settings))) return void await interaction.reply({ content: "Você não tem permissão para usar este sistema.", ephemeral: true });

  const targetUser = interaction.options.getUser("usuario", true);
  const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  const targetName = target?.displayName ?? targetUser.id;
  const staffName = (interaction.member as GuildMember).displayName;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let dmSent = true;
  try {
    await targetUser.send(openPointDmPayload(settings, targetName));
  } catch {
    dmSent = false;
  }

  const counter = await context.api.notifyOpenPoint(interaction.guild.id, { appliedBy: interaction.user.id, userId: targetUser.id });
  const fineStatus = await maybeSendFinePanel(interaction, context, settings, counter, targetName, staffName);
  await sendOpenPointLog(interaction.guild, settings, logPayload(
    dmSent ? "✅ Notificação enviada" : "⚠️ Falha ao enviar DM",
    dmSent ? "A notificação de ponto aberto foi enviada e registrada." : "A notificação foi registrada no contador, mas a DM do usuário falhou.",
    [
      `**Usuário:** <@${targetUser.id}> | ${targetName}`,
      `**Staff:** <@${interaction.user.id}> | ${staffName}`,
      `**Quantidade atual:** ${counter.totalNotifications}`,
      `**Servidor:** ${interaction.guild.name}`,
      `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
    ],
    dmSent ? 0x22c55e : 0xef4444
  ));
  await interaction.editReply(openPointStaffConfirmation(targetUser.id, interaction.user.id, counter, dmSent, fineStatus));
}

async function handleCounterCommand(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return void await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
  const settings = await context.api.getOpenPointSettings(interaction.guild.id);
  if (!(await canUseOpenPoint(interaction, settings))) return void await interaction.reply({ content: "Você não tem permissão para usar este sistema.", ephemeral: true });
  const user = interaction.options.getUser("usuario", true);
  const counter = await context.api.getOpenPointCounter(interaction.guild.id, user.id);
  await interaction.reply({ ...counterPayload(user.id, counter), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

async function handleResetCommand(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return void await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
  const settings = await context.api.getOpenPointSettings(interaction.guild.id);
  if (!(await canUseOpenPoint(interaction, settings))) return void await interaction.reply({ content: "Você não tem permissão para usar este sistema.", ephemeral: true });
  const user = interaction.options.getUser("usuario", true);
  const counter = await context.api.resetOpenPointCounter(interaction.guild.id, user.id, interaction.user.id);
  await sendOpenPointLog(interaction.guild, settings, logPayload("🔄 Contador resetado", "O contador de ponto aberto foi resetado.", [
    `**Usuário:** <@${user.id}>`,
    `**Staff:** <@${interaction.user.id}>`,
    `**Quantidade atual:** ${counter.totalNotifications}`,
    `**Servidor:** ${interaction.guild.name}`,
    `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
  ], 0x5865f2));
  await interaction.reply({ content: `Contador de <@${user.id}> resetado. Total atual: ${counter.totalNotifications}.`, ephemeral: true });
}

async function handleConfigCommand(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return void await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
  const settings = await context.api.getOpenPointSettings(interaction.guild.id);
  if (!(await canUseOpenPoint(interaction, settings, true))) return void await interaction.reply({ content: "Você não tem permissão para configurar este sistema.", ephemeral: true });
  await interaction.reply({ components: configComponents(settings), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

export async function handleOpenPointInteraction(interaction: Interaction, context: BotContext) {
  if (!(interaction.isButton() || interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu())) return false;
  if (!interaction.customId.startsWith(`${PREFIX}:`) || !interaction.guild) return false;
  const [, action, userId] = interaction.customId.split(":");
  const settings = await context.api.getOpenPointSettings(interaction.guild.id);

  if (action?.startsWith("config_")) {
    if (!(await canUseOpenPoint(interaction as never, settings, true))) {
      await interaction.reply({ content: "Você não tem permissão para configurar este sistema.", ephemeral: true });
      return true;
    }
    await handleConfigInteraction(interaction, context, settings, action);
    return true;
  }

  if (!(await canUseOpenPoint(interaction as never, settings))) {
    await interaction.reply({ content: "Você não tem permissão para usar este sistema.", ephemeral: true });
    return true;
  }

  if (action === "fine_applied" && userId && interaction.isButton()) {
    await interaction.update(appliedFinePayload(userId, interaction.user.id));
    await sendOpenPointLog(interaction.guild, settings, logPayload("✅ Multa aplicada", "Uma multa administrativa foi marcada como aplicada.", [
      `**Usuário:** <@${userId}>`,
      `**Staff:** <@${interaction.user.id}>`,
      `**Servidor:** ${interaction.guild.name}`,
      `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
    ], 0x22c55e));
    await interaction.followUp({ content: `Multa aplicada por <@${interaction.user.id}> em <t:${Math.floor(Date.now() / 1000)}:f>.`, ephemeral: true });
    return true;
  }
  if (action === "history" && userId) {
    const counter = await context.api.getOpenPointCounter(interaction.guild.id, userId);
    await interaction.reply({ ...historyPayload(userId, counter), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    return true;
  }
  if (action === "reset" && userId) {
    const counter = await context.api.resetOpenPointCounter(interaction.guild.id, userId, interaction.user.id);
    await sendOpenPointLog(interaction.guild, settings, logPayload("🔄 Contador resetado", "O contador foi resetado pelo painel de multa.", [
      `**Usuário:** <@${userId}>`,
      `**Staff:** <@${interaction.user.id}>`,
      `**Quantidade atual:** ${counter.totalNotifications}`,
      `**Servidor:** ${interaction.guild.name}`,
      `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
    ], 0x5865f2));
    await interaction.reply({ content: `Contador resetado. Total atual: ${counter.totalNotifications}.`, ephemeral: true });
    return true;
  }
  return true;
}

async function handleConfigInteraction(interaction: Interaction, context: BotContext, settings: OpenPointSettings, action: string) {
  if (action === "config_toggle" && interaction.isButton()) {
    const saved = await context.api.saveOpenPointSettings(interaction.guildId!, { enabled: !settings.enabled });
    await logConfigChange(interaction.guild!, saved, interaction.user.id, `Sistema ${saved.enabled ? "ativado" : "desativado"}.`);
    await interaction.update({ components: configComponents(saved) });
    return;
  }
  if (action === "config_mode" && interaction.isButton()) {
    const next = settings.fineMode === "once_at_3" ? "every_after_3" : "once_at_3";
    const saved = await context.api.saveOpenPointSettings(interaction.guildId!, { fineMode: next });
    await logConfigChange(interaction.guild!, saved, interaction.user.id, `Modo de multa alterado para ${saved.fineMode}.`);
    await interaction.update({ components: configComponents(saved) });
    return;
  }
  if (action === "config_allowed_roles" && interaction.isRoleSelectMenu()) {
    const saved = await context.api.saveOpenPointSettings(interaction.guildId!, { allowedRoleIds: interaction.values });
    await logConfigChange(interaction.guild!, saved, interaction.user.id, "Cargos autorizados alterados.");
    await interaction.update({ components: configComponents(saved) });
    return;
  }
  if (action === "config_fine_role" && interaction.isRoleSelectMenu()) {
    const saved = await context.api.saveOpenPointSettings(interaction.guildId!, { fineRoleId: interaction.values[0] ?? null });
    await logConfigChange(interaction.guild!, saved, interaction.user.id, "Cargo de multa alterado.");
    await interaction.update({ components: configComponents(saved) });
    return;
  }
  if (action === "config_fine_channel" && interaction.isChannelSelectMenu()) {
    const saved = await context.api.saveOpenPointSettings(interaction.guildId!, { fineChannelId: interaction.values[0] ?? null });
    await logConfigChange(interaction.guild!, saved, interaction.user.id, "Canal de multa alterado.");
    await interaction.update({ components: configComponents(saved) });
    return;
  }
  if (action === "config_justification_channel" && interaction.isChannelSelectMenu()) {
    const saved = await context.api.saveOpenPointSettings(interaction.guildId!, { justificationChannelId: interaction.values[0] ?? null });
    await logConfigChange(interaction.guild!, saved, interaction.user.id, "Canal de justificativa alterado.");
    await interaction.update({ components: configComponents(saved) });
    return;
  }
  if (action === "config_log_channel" && interaction.isChannelSelectMenu()) {
    const saved = await context.api.saveOpenPointSettings(interaction.guildId!, { logChannelId: interaction.values[0] ?? null });
    await logConfigChange(interaction.guild!, saved, interaction.user.id, "Canal de logs alterado.");
    await interaction.update({ components: configComponents(saved) });
  }
}

async function maybeSendFinePanel(interaction: ChatInputCommandInteraction, context: BotContext, settings: OpenPointSettings, counter: OpenPointCounter, targetName: string, staffName: string) {
  const shouldGenerate = counter.totalNotifications === THRESHOLD || (counter.totalNotifications > THRESHOLD && settings.fineMode === "every_after_3");
  if (!shouldGenerate) return "not_needed";
  if (counter.totalNotifications > THRESHOLD && settings.fineMode === "once_at_3") return "not_needed";
  if (!settings.fineChannelId || !interaction.guild) {
    if (interaction.guild) {
      await sendOpenPointLog(interaction.guild, settings, logPayload("⚠️ Multa não gerada", "O usuário atingiu o limite, mas o canal de multa não está configurado.", [
        `**Usuário:** <@${counter.userId}> | ${targetName}`,
        `**Staff:** <@${interaction.user.id}> | ${staffName}`,
        `**Quantidade atual:** ${counter.totalNotifications}`,
        `**Servidor:** ${interaction.guild.name}`,
        `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
      ], 0xf59e0b));
    }
    return "missing_channel";
  }
  const channel = await interaction.guild.channels.fetch(settings.fineChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return "failed";
  const sent = await channel.send(finePayload(settings, counter.userId, targetName, interaction.user.id, staffName)).then(() => true).catch(() => false);
  if (!sent) return "failed";
  await context.api.markOpenPointFineGenerated(interaction.guild.id, counter.userId);
  await sendOpenPointLog(interaction.guild, settings, logPayload("🚨 Multa gerada", settings.fineRoleId ? "O painel de multa foi enviado." : "O painel de multa foi enviado, mas nenhum cargo de multa está configurado.", [
    `**Usuário:** <@${counter.userId}> | ${targetName}`,
    `**Staff:** <@${interaction.user.id}> | ${staffName}`,
    `**Quantidade atual:** ${counter.totalNotifications}`,
    `**Canal de multa:** <#${settings.fineChannelId}>`,
    `**Servidor:** ${interaction.guild.name}`,
    `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
  ], 0xef4444));
  return "sent";
}

async function canUseOpenPoint(interaction: { guild?: any; member?: unknown; memberPermissions?: any }, settings: OpenPointSettings, manage = false) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const member = interaction.member as GuildMember | null;
  if (!member) return false;
  if (manage && !settings.allowedRoleIds.length) return false;
  return settings.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function openPointDmPayload(settings: OpenPointSettings, targetName: string) {
  return renderComponentsV2Panel({
    accentColor: 0xf59e0b,
    description: "Verificamos que seu ponto de serviço permanece aberto mesmo sem estar em atividade. Reforçamos que essa prática não está de acordo com as diretrizes do departamento.\n\nPedimos que, ao encerrar o serviço ou se ausentar, feche corretamente o ponto. Caso a situação continue ocorrendo, poderá haver aplicação de multa administrativa.",
    fields: [`**Membro:** ${targetName}`, `**Justificativa:** ${settings.justificationChannelId ? `<#${settings.justificationChannelId}>` : "North Police Department 📑│justificar-ponto"}`],
    footerText: "NPD • Sistema de Notificação",
    image: settings.dmBannerUrl ? { imageEnabled: true, imagePosition: "banner", imageUrl: resolvePanelImageUrl(settings.dmBannerUrl) } : null,
    moduleId: MODULE_ID,
    title: "⚠️ Notificação de Ponto em Aberto"
  });
}

function openPointStaffConfirmation(userId: string, staffId: string, counter: OpenPointCounter, dmSent: boolean, fineStatus: FineStatus) {
  return renderComponentsV2Panel({
    accentColor: dmSent ? 0x22c55e : 0xef4444,
    description: dmSent ? "✅ Notificação enviada" : "⚠️ A notificação foi registrada, mas a DM falhou.",
    fields: [
      `**Usuário:** <@${userId}>`,
      `**Total de notificações:** ${counter.totalNotifications}/${THRESHOLD}`,
      `**Aplicado por:** <@${staffId}>`,
      fineStatus === "sent" ? "🚨 O usuário atingiu 3 notificações e foi encaminhado para multa administrativa." : "",
      fineStatus === "missing_channel" ? "⚠️ O usuário atingiu 3 notificações, mas o canal de multa não está configurado." : "",
      fineStatus === "failed" ? "⚠️ O usuário atingiu 3 notificações, mas não foi possível enviar o painel de multa." : ""
    ].filter(Boolean),
    moduleId: MODULE_ID,
    title: "Notificação de Ponto Aberto"
  });
}

function finePayload(settings: OpenPointSettings, userId: string, targetName: string, staffId: string, staffName: string) {
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:fine_applied:${userId}`).setEmoji("✅").setLabel("Multa aplicada").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:history:${userId}`).setEmoji("📑").setLabel("Ver histórico").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}:reset:${userId}`).setEmoji("🔄").setLabel("Resetar contador").setStyle(ButtonStyle.Danger)
  );
  const mention = settings.fineRoleId ? `<@&${settings.fineRoleId}>` : "";
  return {
    ...renderComponentsV2Panel({
      accentColor: 0xef4444,
      actions: [actions],
      description: `${mention ? `${mention}\n\n` : ""}<@${userId}> | ${targetName} atingiu **3 notificações** por ponto aberto e foi encaminhado para aplicação de multa.\n\n**Aplicado por:** <@${staffId}> | ${staffName}`,
      footerText: `NPD • Conselho • ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
      image: settings.fineBannerUrl ? { imageEnabled: true, imagePosition: "banner", imageUrl: resolvePanelImageUrl(settings.fineBannerUrl) } : null,
      moduleId: MODULE_ID,
      title: "🚨 Multa Administrativa — Ponto em Aberto"
    }),
    allowedMentions: { roles: settings.fineRoleId ? [settings.fineRoleId] : [], users: [userId, staffId] }
  };
}

function appliedFinePayload(userId: string, staffId: string) {
  return {
    ...renderComponentsV2Panel({
      accentColor: 0x22c55e,
      description: `<@${userId}> teve a multa administrativa marcada como aplicada.\n\n**Aplicada por:** <@${staffId}>`,
      footerText: `NPD • Conselho • ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
      moduleId: MODULE_ID,
      title: "✅ Multa Administrativa Aplicada"
    }),
    allowedMentions: { users: [userId, staffId] }
  };
}

function counterPayload(userId: string, counter: OpenPointCounter) {
  return renderComponentsV2Panel({
    accentColor: counter.totalNotifications >= THRESHOLD ? 0xef4444 : 0x22c55e,
    description: "Resumo interno das notificações de ponto aberto deste membro.",
    fields: [
      `**Usuário:** <@${userId}>`,
      `**Total de notificações:** ${counter.totalNotifications}`,
      `**Última notificação:** ${counter.lastNotificationAt ? `<t:${Math.floor(new Date(counter.lastNotificationAt).getTime() / 1000)}:f>` : "Nenhuma"}`,
      `**Status:** ${counter.totalNotifications >= THRESHOLD ? "Encaminhado para multa administrativa." : "Sem multa gerada."}`
    ],
    moduleId: MODULE_ID,
    title: "📑 Contador de Ponto Aberto"
  });
}

function historyPayload(userId: string, counter: OpenPointCounter) {
  return renderComponentsV2Panel({
    accentColor: 0x5865f2,
    description: "Histórico interno das notificações aplicadas para este membro.",
    fields: [
      `**Usuário:** <@${userId}>`,
      `**Total:** ${counter.totalNotifications}`,
      `**Histórico recente:**\n${counter.history.slice(-10).reverse().map((item) => `- <t:${Math.floor(new Date(item.at).getTime() / 1000)}:f> por <@${item.appliedBy}>`).join("\n") || "Sem histórico."}`
    ],
    moduleId: MODULE_ID,
    title: "📑 Histórico de Notificações"
  });
}

function configComponents(settings: OpenPointSettings) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:config_toggle`).setLabel(settings.enabled ? "Desativar" : "Ativar").setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:config_mode`).setLabel(settings.fineMode === "once_at_3" ? "Multa só ao atingir 3" : "Multa após toda notificação >=3").setStyle(ButtonStyle.Secondary)
  );
  return [{
    type: 17,
    accent_color: 0x5865f2,
    components: [
      { type: 10, content: `# Notificação de Ponto Aberto\n**Status:** ${settings.enabled ? "Ativo" : "Inativo"}\n**Canal de multa:** ${settings.fineChannelId ? `<#${settings.fineChannelId}>` : "não configurado"}\n**Canal de logs:** ${settings.logChannelId ? `<#${settings.logChannelId}>` : "não configurado"}\n**Cargo de multa:** ${settings.fineRoleId ? `<@&${settings.fineRoleId}>` : "não configurado"}\n**Cargos autorizados:** ${settings.allowedRoleIds.length}` },
      buttons,
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${PREFIX}:config_allowed_roles`).setPlaceholder("Cargos autorizados").setMinValues(0).setMaxValues(25)),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${PREFIX}:config_fine_role`).setPlaceholder("Cargo responsável pela multa").setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${PREFIX}:config_fine_channel`).setPlaceholder("Canal de multas").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${PREFIX}:config_justification_channel`).setPlaceholder("Canal de justificativa").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1)),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${PREFIX}:config_log_channel`).setPlaceholder("Canal de logs").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1))
    ]
  }];
}

async function logConfigChange(guild: Guild, settings: OpenPointSettings, staffId: string, change: string) {
  await sendOpenPointLog(guild, settings, logPayload("⚙️ Configuração alterada", change, [
    `**Staff:** <@${staffId}>`,
    `**Servidor:** ${guild.name}`,
    `**Data:** <t:${Math.floor(Date.now() / 1000)}:f>`
  ], 0x5865f2));
}

async function sendOpenPointLog(guild: Guild, settings: OpenPointSettings, payload: ReturnType<typeof logPayload>) {
  if (!settings.logChannelId) return;
  const channel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  await channel.send(payload).catch(() => undefined);
}

function logPayload(title: string, description: string, fields: string[], accentColor: number) {
  return {
    ...renderComponentsV2Panel({
      accentColor,
      description,
      fields,
      footerText: "NPD • Logs de Ponto Aberto",
      moduleId: MODULE_ID,
      title
    }),
    allowedMentions: { parse: [] }
  };
}
