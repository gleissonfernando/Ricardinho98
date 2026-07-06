import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { BotCommand, BotContext } from "../types";

async function executeAbsenceConfig(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Este comando so pode ser usado em servidores.", ephemeral: true });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) && interaction.guild?.ownerId !== interaction.user.id) {
    await interaction.reply({ content: "Voce precisa ser administrador para configurar ausencias.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const current = await context.api.getFivemFacSettings(interaction.guildId);
  const requestChannel = interaction.options.getChannel("canal_solicitacoes", false, [ChannelType.GuildText]);
  const logChannel = interaction.options.getChannel("canal_logs", false, [ChannelType.GuildText]);
  const absenceRole = interaction.options.getRole("cargo_ausencia", false);
  const approverRole = interaction.options.getRole("cargo_aprovador", false);
  const enabled = interaction.options.getBoolean("ativo") ?? true;
  const publish = interaction.options.getBoolean("publicar_painel") ?? false;

  const settings = await context.api.saveFivemFacSettings(interaction.guildId, {
    enabled,
    panelChannelId: requestChannel?.id ?? current.panelChannelId,
    logChannelId: logChannel?.id ?? current.logChannelId,
    absenceRoleId: absenceRole?.id ?? current.absenceRoleId,
    approverRoleIds: approverRole ? [...new Set([...current.approverRoleIds, approverRole.id])] : current.approverRoleIds
  });

  if (publish && settings.enabled && settings.panelChannelId) {
    await context.api.requestFivemFacPanelPublish(interaction.guildId);
  }

  await interaction.editReply([
    "Configuração de ausência salva.",
    "",
    `Canal de solicitações: ${settings.panelChannelId ? `<#${settings.panelChannelId}>` : "não configurado"}`,
    `Canal de logs: ${settings.logChannelId ? `<#${settings.logChannelId}>` : "não configurado"}`,
    `Cargo de ausência: ${settings.absenceRoleId ? `<@&${settings.absenceRoleId}>` : "não configurado"}`,
    `Cargos aprovadores: ${settings.approverRoleIds.length ? settings.approverRoleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "não configurado"}`,
    `Status: ${settings.enabled ? "ativo" : "inativo"}`,
    "",
    publish ? "Publicação do painel solicitada ao bot." : "Use publicar_painel:true para enviar o painel pelo bot."
  ].join("\n"));
}

function buildAbsenceConfigCommand(name: "ausencia" | "rh") {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription("Configura o sistema de ausência.")
    .addSubcommand((subcommand) => subcommand
      .setName("config")
      .setDescription("Configura canais, cargo de ausência e aprovadores.")
      .addChannelOption((option) => option
        .setName("canal_solicitacoes")
        .setDescription("Canal que receberá os pedidos de ausência.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false))
      .addChannelOption((option) => option
        .setName("canal_logs")
        .setDescription("Canal dos logs de ausência.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false))
      .addRoleOption((option) => option
        .setName("cargo_ausencia")
        .setDescription("Cargo aplicado quando a ausência é aprovada.")
        .setRequired(false))
      .addRoleOption((option) => option
        .setName("cargo_aprovador")
        .setDescription("Cargo autorizado a aprovar ou recusar ausências.")
        .setRequired(false))
      .addBooleanOption((option) => option
        .setName("ativo")
        .setDescription("Ativa ou desativa o sistema de ausência.")
        .setRequired(false))
      .addBooleanOption((option) => option
        .setName("publicar_painel")
        .setDescription("Mantido por compatibilidade. Publique pela dashboard.")
        .setRequired(false)));
}

export const ausenciaCommand: BotCommand = {
  data: buildAbsenceConfigCommand("ausencia"),
  execute: executeAbsenceConfig,
  moduleId: "fivem-fac"
};

export const rhCommand: BotCommand = {
  data: buildAbsenceConfigCommand("rh"),
  execute: executeAbsenceConfig,
  moduleId: "fivem-fac"
};
