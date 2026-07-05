import { SlashCommandBuilder } from "discord.js";
import { showPolicePatrolConfigPanel } from "../services/policePatrolReportService";
import { showPoliceFlightConfigPanel } from "../services/policeFlightService";
import { showSummonsConfigPanel } from "../services/communicationService";
import type { BotCommand } from "../types";

export const configCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configura sistemas administrativos do bot.")
    .addSubcommand((subcommand) => subcommand
      .setName("relatorio")
      .setDescription("Abre o painel de configuracao dos relatorios policiais."))
    .addSubcommand((subcommand) => subcommand
      .setName("daf")
      .setDescription("Abre o painel de configuracao da escalacao aerea DAF."))
    .addSubcommand((subcommand) => subcommand
      .setName("intimar")
      .setDescription("Abre o painel de configuracao das intimacoes.")),
  async execute(interaction, context) {
    if (interaction.options.getSubcommand() === "relatorio") {
      await showPolicePatrolConfigPanel(interaction, context);
    } else if (interaction.options.getSubcommand() === "daf") {
      await showPoliceFlightConfigPanel(interaction, context);
    } else if (interaction.options.getSubcommand() === "intimar") {
      await showSummonsConfigPanel(interaction, context);
    }
  }
};
