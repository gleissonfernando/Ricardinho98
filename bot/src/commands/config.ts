import { ChannelType, SlashCommandBuilder } from "discord.js";
import { showPolicePatrolConfigPanel } from "../services/policePatrolReportService";
import { showPoliceFlightConfigPanel } from "../services/policeFlightService";
import { showPoliceRhConfigPanel } from "../services/policeRhService";
import { showSummonsConfigPanel } from "../services/communicationService";
import { showFivemHierarchyConfigPanel } from "../services/fivemHierarchyService";
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
      .setDescription("Abre o painel de configuracao das intimacoes."))
    .addSubcommand((subcommand) => subcommand
      .setName("hierarquia")
      .setDescription("Abre o painel de configuracao das hierarquias."))
    .addSubcommand((subcommand) => subcommand
      .setName("rh")
      .setDescription("Configura RH, ausencias e adornos sincronizando com a dashboard.")
      .addChannelOption((option) => option.setName("canal_painel").setDescription("Canal do painel principal do RH.").addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addChannelOption((option) => option.setName("canal_ausencia").setDescription("Canal que recebe solicitacoes de ausencia.").addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addChannelOption((option) => option.setName("canal_adorno").setDescription("Canal que recebe solicitacoes de adorno.").addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addChannelOption((option) => option.setName("logs_rh").setDescription("Canal de logs geral do RH.").addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addChannelOption((option) => option.setName("logs_ausencia").setDescription("Canal de logs das ausencias.").addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addChannelOption((option) => option.setName("logs_adorno").setDescription("Canal de logs dos adornos.").addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addRoleOption((option) => option.setName("cargo_ausencia").setDescription("Cargo aplicado quando ausencia for aprovada.").setRequired(false))
      .addRoleOption((option) => option.setName("cargo_aprovador").setDescription("Cargo autorizado a aprovar ausencias.").setRequired(false))
      .addBooleanOption((option) => option.setName("ativo").setDescription("Ativa ou desativa o RH policial.").setRequired(false))
      .addBooleanOption((option) => option.setName("publicar_painel").setDescription("Publica/atualiza o painel depois de salvar.").setRequired(false))),
  async execute(interaction, context) {
    if (interaction.options.getSubcommand() === "relatorio") {
      await showPolicePatrolConfigPanel(interaction, context);
    } else if (interaction.options.getSubcommand() === "daf") {
      await showPoliceFlightConfigPanel(interaction, context);
    } else if (interaction.options.getSubcommand() === "intimar") {
      await showSummonsConfigPanel(interaction, context);
    } else if (interaction.options.getSubcommand() === "hierarquia") {
      await showFivemHierarchyConfigPanel(interaction, context);
    } else if (interaction.options.getSubcommand() === "rh") {
      await showPoliceRhConfigPanel(interaction, context);
    }
  }
};
