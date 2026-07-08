import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import { env } from "../config/env";
import type { BotCommand } from "../types";

export const hostingBackupCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("backup-hospedagem")
    .setDescription("Abre o painel administrativo do Backup de Hospedagem.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  moduleId: "server-backup",
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Voce precisa da permissao Gerenciar Servidor para abrir este painel.", ephemeral: true });
      return;
    }

    const dashboardUrl = `${env.FRONTEND_URL}/dev/backup-de-hospedagem`;
    const embed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setTitle("Backup de Hospedagem")
      .setDescription("Criar backup, importar JSON, exportar historico e acompanhar restauracoes pela area DEV.")
      .addFields(
        { name: "Servidor", value: interaction.guild?.name ?? interaction.guildId, inline: true },
        { name: "Status", value: "Disponivel na Dashboard", inline: true }
      )
      .setTimestamp(new Date());

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Abrir Dashboard")
        .setStyle(ButtonStyle.Link)
        .setURL(dashboardUrl)
    );

    await interaction.reply({ components: [row], embeds: [embed], ephemeral: true });
  }
};
