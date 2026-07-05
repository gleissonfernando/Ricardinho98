import { SlashCommandBuilder } from "discord.js";
import type { BotCommand } from "../types";
import { runPoliceCourseCommand } from "../services/policeCourseService";

export const policeCourseCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("curso")
    .setDescription("Publica e configura cursos da Policia.")
    .addSubcommand((option) => option.setName("publicar").setDescription("Seleciona um curso e publica o painel."))
    .addSubcommand((option) => option.setName("config").setDescription("Abre a configuracao do sistema de cursos.")),
  moduleId: "police-courses",
  execute: runPoliceCourseCommand
};
