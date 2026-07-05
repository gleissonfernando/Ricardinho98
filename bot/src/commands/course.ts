import { SlashCommandBuilder } from "discord.js";
import type { BotCommand } from "../types";
import { runPoliceCourseCommand, runPoliceCourseEditCommand } from "../services/policeCourseService";

export const policeCourseCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("curso")
    .setDescription("Publica e configura cursos da Policia.")
    .addSubcommand((option) => option.setName("iniciar").setDescription("Seleciona e inicia um curso autorizado."))
    .addSubcommand((option) => option.setName("publicar").setDescription("Seleciona um curso e publica o painel."))
    .addSubcommand((option) => option.setName("config").setDescription("Abre a configuracao do sistema de cursos.")),
  moduleId: "police-courses",
  execute: runPoliceCourseCommand
};

export const editPoliceCourseCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("editar")
    .setDescription("Edita uma atividade autorizada.")
    .addSubcommand((option) => option.setName("curso").setDescription("Edita horário, vagas e local de um curso ativo.")),
  moduleId: "police-courses",
  async execute(interaction, context) {
    await runPoliceCourseEditCommand(interaction, context);
  }
};
