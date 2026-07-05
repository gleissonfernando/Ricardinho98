import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { showDmConfigPanel, showDmModal } from "../services/communicationService";
import type { BotCommand } from "../types";

export const dmCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("dm")
    .setDescription("Envia uma mensagem privada oculta.")
    .addStringOption((option) =>
      option
        .setName("imagem_url")
        .setDescription("Imagem temporária desta DM (png, jpg, jpeg, gif ou webp).")
        .setRequired(false)
    ),
  moduleId: "dm-system",
  async execute(interaction, context) {
    await showDmModal(interaction, context);
  }
};

export const dmConfigCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("dmconfig")
    .setDescription("Abre o painel de configuracao do sistema de DM."),
  moduleId: "dm-system",
  async execute(interaction, context) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Você precisa de Gerenciar Servidor.", ephemeral: true });
      return;
    }
    await showDmConfigPanel(interaction, context);
  }
};
