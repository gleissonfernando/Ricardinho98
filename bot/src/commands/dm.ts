import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { showDmConfigPanel, showDmModal } from "../services/communicationService";
import type { BotCommand } from "../types";

export const dmCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("dm")
    .setDescription("Envia e configura mensagens privadas.")
    .addSubcommand((sub) => sub.setName("enviar").setDescription("Envia uma DM personalizada."))
    .addSubcommand((sub) => sub.setName("config").setDescription("Abre o painel de configuracao.")),
  moduleId: "dm-system",
  async execute(interaction, context) {
    if (interaction.options.getSubcommand() === "config") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: "Você precisa de Gerenciar Servidor.", ephemeral: true });
        return;
      }
      await showDmConfigPanel(interaction, context);
      return;
    }
    await showDmModal(interaction, context);
  }
};
