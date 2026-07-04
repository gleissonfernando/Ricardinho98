import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { showPolicePatrolConfigPanel } from "../services/policePatrolReportService";
import type { BotCommand } from "../types";

export const configCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configura sistemas administrativos do bot.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) => subcommand
      .setName("relatorio")
      .setDescription("Abre o painel de configuracao dos relatorios policiais.")),
  moduleId: "police-patrol-reports",
  async execute(interaction, context) {
    if (interaction.options.getSubcommand() === "relatorio") {
      await showPolicePatrolConfigPanel(interaction, context);
    }
  }
};
