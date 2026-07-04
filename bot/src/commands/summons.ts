import { SlashCommandBuilder } from "discord.js";
import { showSummonsModal } from "../services/communicationService";
import type { BotCommand } from "../types";

export const summonsCommand: BotCommand = {
  data: new SlashCommandBuilder().setName("intimacao").setDescription("Cria uma intimacao privada temporaria."),
  moduleId: "summons-system",
  async execute(interaction, context) {
    await showSummonsModal(interaction, context);
  }
};
