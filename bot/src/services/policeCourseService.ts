import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type MessageCreateOptions,
  type TextChannel
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";
import type { PoliceCourse, PoliceCourseConfig } from "./apiClient";
import { renderComponentsV2Panel } from "./panelVisualRenderer";

const MODULE_ID = "police-courses";
const PREFIX = "police_course";
const STYLE: Record<PoliceCourseConfig["joinButtonStyle"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger
};

export function startPoliceCourseService(context: BotContext) {
  context.socket.onPoliceCoursePanelUpdate((payload) => {
    const runtimeBotId = currentRuntimeBotId();
    if (payload.botId && runtimeBotId && payload.botId !== runtimeBotId) return;
    if (!payload.courseId) return;
    void refreshOrPublishCourse(context, payload.guildId, payload.courseId, payload.action === "publish" ? payload.channelId : null)
      .catch((error) => console.warn("[police-courses] falha ao sincronizar painel:", error instanceof Error ? error.message : error));
  });
}

export async function runPoliceCourseCommand(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
    return;
  }
  const config = await context.api.getPoliceCourseConfig(interaction.guildId);
  if (!config.enabled) {
    await interaction.reply({ content: "O sistema de cursos esta desativado.", ephemeral: true });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "config") {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config.allowedManagerRoles)) {
      await interaction.reply({ content: "Voce nao tem permissao para configurar cursos.", ephemeral: true });
      return;
    }
    await interaction.reply({ ...configPanel(config), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    return;
  }
  const courses = (await context.api.listPoliceCourses(interaction.guildId)).filter((course) => course.status === "open");
  if (!courses.length) {
    await interaction.reply({ content: "Nenhum curso aberto foi cadastrado.", ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:select`)
    .setPlaceholder("Selecione pelo numero ou nome")
    .addOptions(courses.slice(0, 25).map((course) => ({
      label: `${course.courseNumber} - ${course.title}`.slice(0, 100),
      description: `${course.date} ${course.time} • ${course.participants.length}${course.maxSlots ? `/${course.maxSlots}` : ""} inscritos`.slice(0, 100),
      value: course.id
    })));
  await interaction.reply({
    components: [{ type: 17, accent_color: 0x2563eb, components: [
      { type: 10, content: "# Cursos / Treinamentos\nSelecione o curso que deseja publicar." },
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON()
    ] }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

export async function handlePoliceCourseInteraction(interaction: Interaction, context: BotContext) {
  if (!(interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guildId || !interaction.guild || !isBotModuleEnabled(MODULE_ID)) {
    if (interaction.isRepliable()) await interaction.reply({ content: "Sistema de cursos indisponivel.", ephemeral: true }).catch(() => undefined);
    return true;
  }
  const [, action, courseId] = interaction.customId.split(":");
  const config = await context.api.getPoliceCourseConfig(interaction.guildId);

  if (action === "select" && interaction.isStringSelectMenu()) {
    const selectedId = interaction.values[0];
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`${PREFIX}:channel:${selectedId}`)
      .setPlaceholder("Escolha o canal do painel")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    await interaction.update({
      components: [{ type: 17, accent_color: color(config.accentColor), components: [
        { type: 10, content: "# Publicar curso\nAgora selecione o canal onde o painel sera enviado." },
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect).toJSON()
      ] }]
    });
    return true;
  }

  if (action === "channel" && interaction.isChannelSelectMenu() && courseId) {
    await interaction.deferUpdate();
    const channelId = interaction.values[0];
    if (!channelId) throw new Error("Canal nao selecionado.");
    await publishCourse(context, interaction.guild, courseId, channelId, interaction.user.id);
    await interaction.editReply({ components: [{ type: 17, accent_color: color(config.accentColor), components: [{ type: 10, content: "## Painel publicado\nO curso foi enviado e continuara sincronizado com a dashboard." }] }] });
    return true;
  }

  if (action === "join" && interaction.isButton() && courseId) {
    await interaction.deferReply({ ephemeral: true });
    const member = interaction.member as GuildMember;
    const course = await context.api.joinPoliceCourse(interaction.guildId, courseId, {
      userId: interaction.user.id,
      guildNickname: member.nickname,
      username: interaction.user.username
    });
    await updatePublishedPanel(context, interaction.guild, course, config);
    await interaction.editReply({ content: "Voce foi inscrito no curso com sucesso." });
    await sendCourseLog(interaction.guild, config, course, "Usuario entrou no curso", interaction.user.id);
    return true;
  }

  if (action === "leave" && interaction.isButton() && courseId) {
    await interaction.deferReply({ ephemeral: true });
    const course = await context.api.leavePoliceCourse(interaction.guildId, courseId, interaction.user.id);
    await updatePublishedPanel(context, interaction.guild, course, config);
    await interaction.editReply({ content: "Voce saiu do curso com sucesso." });
    await sendCourseLog(interaction.guild, config, course, "Usuario saiu do curso", interaction.user.id);
    return true;
  }

  if ((action === "finish" || action === "cancel") && interaction.isButton() && courseId) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config.allowedFinishRoles)) {
      await interaction.reply({ content: "Voce nao tem permissao para encerrar cursos.", ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const status = action === "finish" ? "finished" : "canceled";
    const course = await context.api.closePoliceCourse(interaction.guildId, courseId, status, interaction.user.id);
    await finalizeCourse(context, interaction.guild, course, config);
    await interaction.editReply({ content: status === "finished" ? "Curso finalizado com sucesso." : "Curso cancelado com sucesso." });
    return true;
  }

  if (action === "create" && interaction.isButton()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config.allowedManagerRoles)) {
      await interaction.reply({ content: "Voce nao tem permissao para criar cursos.", ephemeral: true });
      return true;
    }
    const modal = new ModalBuilder().setCustomId(`${PREFIX}:create_submit`).setTitle("Cadastrar curso");
    modal.addComponents(
      inputRow("number", "Numero do curso", TextInputStyle.Short, true),
      inputRow("title", "Nome do curso", TextInputStyle.Short, true),
      inputRow("instructor", "Instrutor responsavel", TextInputStyle.Short, true),
      inputRow("schedule", "Data e horario (ex: 04/06/2026 | 17:00)", TextInputStyle.Short, true),
      inputRow("details", "Local | vagas | descricao", TextInputStyle.Paragraph, true)
    );
    await interaction.showModal(modal);
    return true;
  }

  if (action === "create_submit" && interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true });
    const schedule = interaction.fields.getTextInputValue("schedule").split("|").map((value) => value.trim());
    const details = interaction.fields.getTextInputValue("details").split("|").map((value) => value.trim());
    const maxSlots = Number.parseInt(details[1] ?? "", 10);
    const course = await context.api.createPoliceCourse(interaction.guildId, {
      actorId: interaction.user.id,
      courseNumber: interaction.fields.getTextInputValue("number"),
      title: interaction.fields.getTextInputValue("title"),
      instructorName: interaction.fields.getTextInputValue("instructor"),
      date: schedule[0] || "A definir",
      time: schedule[1] || "A definir",
      location: details[0] || "A definir",
      maxSlots: Number.isFinite(maxSlots) && maxSlots > 0 ? maxSlots : null,
      description: details.slice(2).join(" | ")
    });
    await interaction.editReply({ content: `Curso ${course.courseNumber} - ${course.title} criado. O banner e os demais textos podem ser ajustados na dashboard.` });
    await sendCourseLog(interaction.guild, config, course, "Curso criado", interaction.user.id);
    return true;
  }

  if ((action === "manager_roles" || action === "finish_roles") && interaction.isRoleSelectMenu()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config.allowedManagerRoles)) {
      await interaction.reply({ content: "Sem permissao.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    const patch = action === "manager_roles" ? { allowedManagerRoles: interaction.values } : { allowedFinishRoles: interaction.values };
    await context.api.savePoliceCourseConfig(interaction.guildId, { ...patch, actorId: interaction.user.id });
    return true;
  }

  return true;
}

async function refreshOrPublishCourse(context: BotContext, guildId: string, courseId: string, channelId: string | null | undefined) {
  const guild = context.client.guilds.cache.get(guildId);
  if (!guild) return;
  const [course, config] = await Promise.all([context.api.getPoliceCourse(guildId, courseId), context.api.getPoliceCourseConfig(guildId)]);
  if (channelId) await publishCourse(context, guild, courseId, channelId, null);
  else await updatePublishedPanel(context, guild, course, config);
}

async function publishCourse(context: BotContext, guild: Interaction["guild"] & {}, courseId: string, channelId: string, actorId: string | null) {
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) throw new Error("Canal de texto invalido.");
  const [course, config] = await Promise.all([context.api.getPoliceCourse(guild.id, courseId), context.api.getPoliceCourseConfig(guild.id)]);
  if (course.panelMessageId && course.panelChannelId) {
    const oldChannel = await guild.channels.fetch(course.panelChannelId).catch(() => null);
    if (oldChannel?.isTextBased() && !oldChannel.isDMBased()) {
      const existing = await oldChannel.messages.fetch(course.panelMessageId).catch(() => null);
      if (existing) {
        await existing.edit(coursePanel(course, config) as any);
        return;
      }
    }
  }
  const message = await channel.send(coursePanel(course, config) as MessageCreateOptions);
  await context.api.setPoliceCoursePanel(guild.id, course.id, { panelChannelId: channel.id, panelMessageId: message.id, actorId });
  await sendCourseLog(guild, config, course, "Curso publicado", actorId);
}

async function updatePublishedPanel(context: BotContext, guild: Interaction["guild"] & {}, course: PoliceCourse, config: PoliceCourseConfig) {
  if (!course.panelChannelId || !course.panelMessageId) return;
  const channel = await guild.channels.fetch(course.panelChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  const message = await channel.messages.fetch(course.panelMessageId).catch(() => null);
  if (message) await message.edit(coursePanel(course, config) as any);
}

async function finalizeCourse(context: BotContext, guild: Interaction["guild"] & {}, course: PoliceCourse, config: PoliceCourseConfig) {
  if (course.status === "canceled" && config.deletePanelOnCancel && course.panelChannelId && course.panelMessageId) {
    const channel = await guild.channels.fetch(course.panelChannelId).catch(() => null);
    if (channel?.isTextBased() && !channel.isDMBased()) await channel.messages.delete(course.panelMessageId).catch(() => undefined);
  } else {
    await updatePublishedPanel(context, guild, course, config);
  }
  const shouldLock = course.status === "finished" ? config.lockChannelOnFinish : config.lockChannelOnCancel;
  if (shouldLock && course.panelChannelId) {
    const channel = await guild.channels.fetch(course.panelChannelId).catch(() => null);
    if (channel?.isTextBased() && !channel.isDMBased() && "permissionOverwrites" in channel) {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => undefined);
    }
  }
  const shouldDm = course.status === "finished" ? config.dmOnFinish : config.dmOnCancel;
  if (shouldDm) {
    await Promise.allSettled(course.participants.map(async (participant) => {
      const user = await guild.client.users.fetch(participant.userId);
      await user.send(course.status === "finished" ? `O curso ${course.title} foi finalizado.` : `O curso ${course.title} foi cancelado.`);
    }));
  }
  await sendCourseLog(guild, config, course, course.status === "finished" ? "Curso finalizado" : "Curso cancelado", course.createdBy);
}

function coursePanel(course: PoliceCourse, config: PoliceCourseConfig) {
  const closed = course.status === "finished" || course.status === "canceled";
  const confirmed = course.participants.length
    ? course.participants.map((item, index) => `${index + 1}. ${escapeMarkdown(item.guildNickname || item.username)}${item.passportId ? ` | ${item.passportId}` : ""}`).join("\n")
    : "Nenhum participante confirmado.";
  const statusText = course.status === "finished"
    ? "## Curso finalizado\nEste curso foi encerrado pela equipe responsavel."
    : course.status === "canceled"
      ? "## Curso cancelado\nEste curso foi cancelado pela equipe responsavel."
      : config.panelText;
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:join:${course.id}`).setLabel("Entrar no Curso").setEmoji("✅").setStyle(STYLE[config.joinButtonStyle]).setDisabled(closed),
    new ButtonBuilder().setCustomId(`${PREFIX}:leave:${course.id}`).setLabel("Sair do Curso").setEmoji("🚪").setStyle(STYLE[config.leaveButtonStyle]).setDisabled(closed),
    new ButtonBuilder().setCustomId(`${PREFIX}:finish:${course.id}`).setLabel("Curso Finalizado").setEmoji("🏁").setStyle(ButtonStyle.Success).setDisabled(closed),
    new ButtonBuilder().setCustomId(`${PREFIX}:cancel:${course.id}`).setLabel("Cancelar Curso").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(closed)
  );
  return renderComponentsV2Panel({
    accentColor: color(config.accentColor),
    moduleId: MODULE_ID,
    headerText: `### ${config.panelHeader}`,
    title: `CURSO DISPONIVEL: ${course.title}`,
    description: statusText,
    fields: [
      `**INSTRUTOR**\n${course.instructorId ? `<@${course.instructorId}>` : escapeMarkdown(course.instructorName)}`,
      `**HORARIO**\n${escapeMarkdown(course.date)} as ${escapeMarkdown(course.time)}`,
      `**LOCAL**\n${escapeMarkdown(course.location)}`,
      `**CONFIRMADOS (${course.participants.length}${course.maxSlots ? `/${course.maxSlots}` : ""})**\n${confirmed}`,
      `**ID DO CURSO**\n${escapeMarkdown(course.courseNumber)}`,
      course.description ? `**DESCRICAO**\n${escapeMarkdown(course.description)}` : ""
    ].filter(Boolean),
    image: course.bannerUrl ? { imageEnabled: true, imagePosition: "bottom", imageUrl: course.bannerUrl } : null,
    actions: [actions.toJSON()]
  });
}

function configPanel(config: PoliceCourseConfig) {
  const managerRoles = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}:manager_roles`).setPlaceholder("Cargos que gerenciam cursos").setMinValues(0).setMaxValues(10);
  const finishRoles = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}:finish_roles`).setPlaceholder("Cargos que finalizam ou cancelam").setMinValues(0).setMaxValues(10);
  const create = new ButtonBuilder().setCustomId(`${PREFIX}:create`).setLabel("Cadastrar Curso").setEmoji("➕").setStyle(ButtonStyle.Primary);
  return {
    components: [{ type: 17, accent_color: color(config.accentColor), components: [
      { type: 10, content: "# Cursos / Treinamentos\nCadastre cursos e defina os cargos autorizados. Configuracoes avancadas e upload de banner ficam sincronizados pela dashboard." },
      new ActionRowBuilder<ButtonBuilder>().addComponents(create).toJSON(),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(managerRoles).toJSON(),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(finishRoles).toJSON()
    ] }]
  };
}

async function sendCourseLog(guild: Interaction["guild"] & {}, config: PoliceCourseConfig, course: PoliceCourse, action: string, actorId: string | null) {
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  await channel.send({
    components: [{ type: 17, accent_color: color(config.accentColor), components: [{ type: 10, content:
      `# LOG DO SISTEMA DE CURSOS\n**Acao:** ${action}\n**Curso:** ${escapeMarkdown(course.title)}\n**ID do Curso:** ${escapeMarkdown(course.courseNumber)}\n**Responsavel:** ${actorId ? `<@${actorId}>` : "Sistema"}\n**Canal do Painel:** ${course.panelChannelId ? `<#${course.panelChannelId}>` : "Nao publicado"}`
    }] }],
    flags: MessageFlags.IsComponentsV2
  }).catch(() => undefined);
}

function canManage(member: GuildMember, ownerId: string, roleIds: string[]) {
  return member.id === ownerId || member.permissions.has(PermissionFlagsBits.Administrator) || roleIds.some((roleId) => member.roles.cache.has(roleId));
}
function inputRow(id: string, label: string, style: TextInputStyle, required: boolean) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(style === TextInputStyle.Paragraph ? 1000 : 100));
}
function color(value: string) { return Number.parseInt(value.replace("#", ""), 16) || 0x2563eb; }
function escapeMarkdown(value: string) { return value.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1"); }
