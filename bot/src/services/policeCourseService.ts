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
  UserSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type MessageCreateOptions,
  type TextChannel
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";
import type { PoliceCourse, PoliceCourseConfig } from "./apiClient";
import { resolvePanelImageUrl } from "./panelVisualRenderer";
import { sendPoliceLog } from "./policeLogService";

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
    if (payload.action === "config_updated") {
      void refreshPublishedCourses(context, payload.guildId)
        .catch((error) => console.warn("[police-courses] falha ao sincronizar configuracao:", error instanceof Error ? error.message : error));
      return;
    }
    if (!payload.courseId || payload.action === "course_deleted") return;
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
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Voce nao tem permissao para configurar cursos.", ephemeral: true });
      return;
    }
    const courses = await context.api.listPoliceCourses(interaction.guildId);
    await interaction.reply({ ...configPanel(config, courses), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    return;
  }
  const member = interaction.member as GuildMember;
  const courses = (await context.api.listPoliceCourses(interaction.guildId))
    .filter(canStartCourse)
    .filter((course) => canTeach(member, interaction.guild!.ownerId, config, course));
  if (!courses.length) {
    await interaction.reply({ content: "Você não possui nenhum curso autorizado para iniciar.", ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:start_select`)
    .setPlaceholder("Selecione o curso")
    .addOptions(courses.slice(0, 25).map((course) => ({
      label: `${course.courseNumber} - ${course.title}`.slice(0, 100),
      description: "Abrir uma nova turma deste curso",
      value: course.id
    })));
  await interaction.reply({
    components: [{ type: 17, accent_color: 0x2563eb, components: [
      { type: 10, content: "# Iniciar curso\nSelecione um dos cursos em que você está cadastrado como instrutor." },
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON()
    ] }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

export async function runPoliceCourseEditCommand(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guildId || !interaction.guild) return;
  const [config, allCourses] = await Promise.all([
    context.api.getPoliceCourseConfig(interaction.guildId),
    context.api.listPoliceCourses(interaction.guildId)
  ]);
  const member = interaction.member as GuildMember;
  const courses = allCourses.filter((course) =>
    (course.status === "open" || course.status === "in_progress")
    && canTeach(member, interaction.guild!.ownerId, config, course)
  );
  if (!courses.length) {
    await interaction.reply({ content: "Você não possui nenhum curso autorizado para editar.", ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:edit_select`)
    .setPlaceholder("Selecione o curso ativo")
    .addOptions(courses.slice(0, 25).map((course) => ({
      label: course.title.slice(0, 100),
      description: `${course.time} • ${course.location}`.slice(0, 100),
      value: course.id
    })));
  await interaction.reply({
    components: [{ type: 17, accent_color: color(config.accentColor), components: [
      { type: 10, content: "# Editar curso\nSelecione uma turma ativa para alterar horário, vagas e local." },
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

  if (action === "start_select" && interaction.isStringSelectMenu()) {
    const selectedId = interaction.values[0];
    if (!selectedId) return true;
    const course = await context.api.getPoliceCourse(interaction.guildId, selectedId);
    if (!canStartCourse(course)) {
      await interaction.reply({ content: "Este curso ja possui uma turma ativa.", ephemeral: true });
      return true;
    }
    if (!canTeach(interaction.member as GuildMember, interaction.guild.ownerId, config, course)) {
      await interaction.reply({ content: "Você não possui permissão para iniciar este curso.", ephemeral: true });
      return true;
    }
    await interaction.showModal(courseSessionModal("start_submit", selectedId, course));
    return true;
  }

  if (action === "start_submit" && interaction.isModalSubmit() && courseId) {
    await interaction.deferReply({ ephemeral: true });
    const course = await context.api.getPoliceCourse(interaction.guildId, courseId);
    const member = interaction.member as GuildMember;
    if (!canTeach(member, interaction.guild.ownerId, config, course)) {
      await interaction.editReply("Você não possui permissão para iniciar este curso.");
      return true;
    }
    const channelId = course.panelChannelId || config.defaultPanelChannelId;
    if (!canStartCourse(course)) {
      await interaction.editReply("Este curso ja possui uma turma ativa.");
      return true;
    }
    if (!channelId) {
      await interaction.editReply("Configure o canal do painel deste curso antes de iniciá-lo.");
      return true;
    }
    const maxSlots = Number.parseInt(interaction.fields.getTextInputValue("maxSlots"), 10);
    if (!Number.isFinite(maxSlots) || maxSlots < 1 || maxSlots > 500) {
      await interaction.editReply("A quantidade máxima deve estar entre 1 e 500.");
      return true;
    }
    const started = await context.api.startPoliceCourse(interaction.guildId, courseId, {
      actorId: interaction.user.id,
      date: interaction.fields.getTextInputValue("date"),
      instructorId: interaction.user.id,
      instructorName: member.displayName,
      location: interaction.fields.getTextInputValue("location"),
      maxSlots,
      time: interaction.fields.getTextInputValue("time")
    });
    await publishCourse(context, interaction.guild, courseId, channelId, interaction.user.id);
    await interaction.editReply("Curso iniciado e painel publicado.");
    await sendCourseLog(interaction.guild, config, started, "Curso iniciado", interaction.user.id);
    return true;
  }

  if (action === "join" && interaction.isButton() && courseId) {
    await interaction.deferReply({ ephemeral: true });
    const member = interaction.member as GuildMember;
    const current = await context.api.getPoliceCourse(interaction.guildId, courseId);
    if (current.status !== "open" && !(current.status === "in_progress" && config.allowJoinAfterStart)) {
      await interaction.editReply({ content: "Este curso nao esta aberto para novas inscricoes." });
      return true;
    }
    if (current.participantRoleIds.length && !current.participantRoleIds.some((roleId) => member.roles.cache.has(roleId))) {
      await interaction.editReply({ content: "Voce nao possui cargo permitido para participar deste curso." });
      return true;
    }
    if (current.maxSlots && current.participants.length >= current.maxSlots) {
      await interaction.editReply({ content: "Este curso atingiu o limite maximo de participantes." });
      return true;
    }
    const course = await context.api.joinPoliceCourse(interaction.guildId, courseId, {
      userId: interaction.user.id,
      guildNickname: member.nickname,
      username: member.displayName
    });
    await updatePublishedPanel(context, interaction.guild, course, config);
    await interaction.editReply({ content: "Voce foi inscrito no curso com sucesso." });
    await sendCourseLog(interaction.guild, config, course, "Usuario entrou no curso", interaction.user.id);
    return true;
  }

  if (action === "leave" && interaction.isButton() && courseId) {
    await interaction.deferReply({ ephemeral: true });
    const current = await context.api.getPoliceCourse(interaction.guildId, courseId);
    if (current.status === "in_progress" && !config.allowLeaveAfterStart) {
      await interaction.editReply({ content: "Nao e possivel sair depois que o curso iniciou." });
      return true;
    }
    const course = await context.api.leavePoliceCourse(interaction.guildId, courseId, interaction.user.id);
    await updatePublishedPanel(context, interaction.guild, course, config);
    await interaction.editReply({ content: "Voce saiu do curso com sucesso." });
    await sendCourseLog(interaction.guild, config, course, "Usuario saiu do curso", interaction.user.id);
    return true;
  }

  if (action === "begin" && interaction.isButton() && courseId) {
    const current = await context.api.getPoliceCourse(interaction.guildId, courseId);
    if (!canControlCourse(interaction.member as GuildMember, interaction.guild.ownerId, config, current)) {
      await interaction.reply({ content: "Você não possui permissão para gerenciar este curso.", ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const course = await context.api.beginPoliceCourse(interaction.guildId, courseId, interaction.user.id);
    await updatePublishedPanel(context, interaction.guild, course, config);
    await interaction.editReply({ content: "Curso iniciado." });
    await sendCourseLog(interaction.guild, config, course, "Curso iniciado", interaction.user.id);
    return true;
  }

  if ((action === "finish" || action === "cancel") && interaction.isButton() && courseId) {
    const current = await context.api.getPoliceCourse(interaction.guildId, courseId);
    if (!canControlCourse(interaction.member as GuildMember, interaction.guild.ownerId, config, current)) {
      await interaction.reply({ content: "Voce nao tem permissao para encerrar cursos.", ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const status = action === "finish" ? "finished" : "canceled";
    const course = await context.api.closePoliceCourse(interaction.guildId, courseId, status, interaction.user.id);
    await finalizeCourse(context, interaction.guild, course, config, interaction.user.id);
    await interaction.editReply({ content: status === "finished" ? "Curso finalizado com sucesso." : "Curso cancelado com sucesso." });
    return true;
  }

  if (action === "create" && interaction.isButton()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Voce nao tem permissao para criar cursos.", ephemeral: true });
      return true;
    }
    const modal = new ModalBuilder().setCustomId(`${PREFIX}:create_submit`).setTitle("Cadastrar curso");
    modal.addComponents(
      inputRow("title", "Nome do curso", TextInputStyle.Short, true),
      inputRow("description", "Descricao do curso", TextInputStyle.Paragraph, false),
      inputValueRow("color", "Cor da embed", "#2563eb", "Ex: #2563eb"),
      inputValueRow("emoji", "Emoji", "", "Ex: 🎓"),
      inputValueRow("maxSlots", "Quantidade maxima de participantes", "", "Ex: 30")
    );
    await interaction.showModal(modal);
    return true;
  }

  if (action === "config_save" && interaction.isButton()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Sem permissao.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    const courses = await context.api.listPoliceCourses(interaction.guildId);
    await interaction.editReply(configPanel(config, courses, "Configuracao salva."));
    return true;
  }

  if (action === "config_select" && interaction.isStringSelectMenu()) {
    const selectedId = interaction.values[0];
    if (!selectedId || !canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Sem permissão.", ephemeral: true });
      return true;
    }
    const selected = await context.api.getPoliceCourse(interaction.guildId, selectedId);
    await interaction.update(configureCoursePanel(selected));
    return true;
  }

  if (action === "config_back" && interaction.isButton()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Sem permissao.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    const courses = await context.api.listPoliceCourses(interaction.guildId);
    await interaction.editReply(configPanel(config, courses));
    return true;
  }

  if (action === "create_submit" && interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true });
    const course = await context.api.createPoliceCourse(interaction.guildId, {
      actorId: interaction.user.id,
      courseNumber: `CURSO-${Date.now().toString(36).toUpperCase()}`,
      color: interaction.fields.getTextInputValue("color"),
      description: interaction.fields.getTextInputValue("description"),
      emoji: interaction.fields.getTextInputValue("emoji"),
      maxSlots: Number.parseInt(interaction.fields.getTextInputValue("maxSlots"), 10) || null,
      title: interaction.fields.getTextInputValue("title"),
      panelChannelId: config.defaultPanelChannelId
    });
    await interaction.editReply(configureCoursePanel(course));
    await sendCourseLog(interaction.guild, config, course, "Curso criado", interaction.user.id);
    return true;
  }

  if ((action === "course_roles" || action === "course_users" || action === "course_channel") && courseId && interaction.isAnySelectMenu()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Sem permissão.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    const patch = action === "course_roles"
      ? { authorizedRoleIds: interaction.values }
      : action === "course_users"
        ? { authorizedUserIds: interaction.values }
        : { panelChannelId: interaction.values[0] ?? null };
    const saved = await context.api.updatePoliceCourse(interaction.guildId, courseId, { ...patch, actorId: interaction.user.id });
    await interaction.editReply(configureCoursePanel(saved));
    return true;
  }

  if (action === "course_save" && courseId && interaction.isButton()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Sem permissão.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    const saved = await context.api.getPoliceCourse(interaction.guildId, courseId);
    await interaction.editReply(configureCoursePanel(saved, "Curso salvo."));
    return true;
  }

  if (action === "edit_select" && interaction.isStringSelectMenu()) {
    const selectedId = interaction.values[0];
    if (!selectedId) return true;
    const selected = await context.api.getPoliceCourse(interaction.guildId, selectedId);
    if (!canTeach(interaction.member as GuildMember, interaction.guild.ownerId, config, selected)) {
      await interaction.reply({ content: "Você não pode editar este curso.", ephemeral: true });
      return true;
    }
    await interaction.showModal(courseSessionModal("edit_submit", selected.id, selected));
    return true;
  }

  if (action === "edit_submit" && interaction.isModalSubmit() && courseId) {
    await interaction.deferReply({ ephemeral: true });
    const current = await context.api.getPoliceCourse(interaction.guildId, courseId);
    if (!canTeach(interaction.member as GuildMember, interaction.guild.ownerId, config, current)) {
      await interaction.editReply("Você não pode editar este curso.");
      return true;
    }
    const maxSlots = Number.parseInt(interaction.fields.getTextInputValue("maxSlots"), 10);
    if (!Number.isFinite(maxSlots) || maxSlots < current.participants.length || maxSlots > 500) {
      await interaction.editReply(`A quantidade deve ser entre ${Math.max(1, current.participants.length)} e 500.`);
      return true;
    }
    const saved = await context.api.updatePoliceCourse(interaction.guildId, courseId, {
      actorId: interaction.user.id,
      location: interaction.fields.getTextInputValue("location"),
      maxSlots,
      time: interaction.fields.getTextInputValue("time")
    });
    await updatePublishedPanel(context, interaction.guild, saved, config);
    await sendCourseLog(interaction.guild, config, saved, "Curso editado", interaction.user.id);
    await interaction.editReply("Curso atualizado.");
    return true;
  }

  if ((action === "manager_roles" || action === "finish_roles") && interaction.isRoleSelectMenu()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Sem permissao.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    const patch = action === "manager_roles" ? { allowedManagerRoles: interaction.values } : { allowedFinishRoles: interaction.values };
    await context.api.savePoliceCourseConfig(interaction.guildId, { ...patch, actorId: interaction.user.id });
    return true;
  }

  if (action === "manager_users" && interaction.isUserSelectMenu()) {
    if (!canManage(interaction.member as GuildMember, interaction.guild.ownerId, config)) {
      await interaction.reply({ content: "Sem permissao.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    await context.api.savePoliceCourseConfig(interaction.guildId, { generalManagerUserIds: interaction.values, actorId: interaction.user.id });
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

async function refreshPublishedCourses(context: BotContext, guildId: string) {
  const guild = context.client.guilds.cache.get(guildId);
  if (!guild) return;
  const [config, courses] = await Promise.all([
    context.api.getPoliceCourseConfig(guildId),
    context.api.listPoliceCourses(guildId)
  ]);

  await Promise.allSettled(
    courses
      .filter((course) => course.panelChannelId && course.panelMessageId)
      .map((course) => updatePublishedPanel(context, guild, course, config))
  );
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

async function finalizeCourse(context: BotContext, guild: Interaction["guild"] & {}, course: PoliceCourse, config: PoliceCourseConfig, actorId: string) {
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
  await sendCourseLog(guild, config, course, course.status === "finished" ? "Curso finalizado" : "Curso cancelado", actorId);
}

function coursePanel(course: PoliceCourse, config: PoliceCourseConfig) {
  const closed = course.status === "finished" || course.status === "canceled";
  const full = Boolean(course.maxSlots && course.participants.length >= course.maxSlots);
  const inProgressJoinBlocked = course.status === "in_progress" && !config.allowJoinAfterStart;
  const inProgressLeaveBlocked = course.status === "in_progress" && !config.allowLeaveAfterStart;
  const participantLimit = course.maxSlots ? `/${course.maxSlots}` : "";
  const confirmed = course.participants.length
    ? course.participants.slice(0, 20).map((item, index) => {
      const name = item.guildNickname || item.username || item.userId;
      return `${index + 1}. ${escapeMarkdown(name)} | ${item.userId}`;
    }).join("\n")
    : "Nenhum participante confirmado.";
  const overflow = course.participants.length > 20 ? `\n...mais ${course.participants.length - 20} participante(s).` : "";
  const statusLine = courseStatusLine(course);
  const imageUrl = course.bannerUrl && course.imagePosition !== "none" ? resolvePanelImageUrl(course.bannerUrl) : null;
  const content = [
    `### ${escapeMarkdown(config.panelHeader || "North Police Department - Instructor Team")}`,
    "",
    `🚨 **CURSO DISPONÍVEL: ${escapeMarkdown(course.title.toUpperCase())}**`,
    course.category ? `**Categoria:** ${escapeMarkdown(course.category)}` : "",
    "",
    `🚔 **INSTRUTOR**                                   ⏰ **HORÁRIO ${course.participants.length}${participantLimit}**`,
    `${formatInstructor(course)}                    ${formatSchedule(course)}`,
    "",
    `📍 **LOCAL**`,
    escapeMarkdown(course.location || "A definir"),
    "",
    `✅ **CONFIRMADOS (${course.participants.length}${participantLimit})**`,
    `${confirmed}${overflow}`,
    "",
    `🆔 **ID DO CURSO**`,
    escapeMarkdown(course.courseNumber),
    statusLine ? `\n${statusLine}` : "",
    course.description ? `\n📝 **DESCRIÇÃO**\n${escapeMarkdown(course.description)}` : ""
  ].filter((line) => line !== "").join("\n");
  const memberActions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:join:${course.id}`).setLabel("INSCREVER").setEmoji("✅").setStyle(STYLE[config.joinButtonStyle]).setDisabled(closed || full || inProgressJoinBlocked),
    new ButtonBuilder().setCustomId(`${PREFIX}:leave:${course.id}`).setLabel("SAIR").setEmoji("🚪").setStyle(STYLE[config.leaveButtonStyle]).setDisabled(closed || inProgressLeaveBlocked)
  );
  const managerActions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:begin:${course.id}`).setLabel("INICIAR CURSO").setEmoji("▶️").setStyle(ButtonStyle.Primary).setDisabled(closed || course.status === "in_progress"),
    new ButtonBuilder().setCustomId(`${PREFIX}:cancel:${course.id}`).setLabel("CANCELAR CURSO").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(closed)
  );
  const components: unknown[] = [{ type: 10, content }];

  if (imageUrl) {
    components.push({ type: 12, items: [{ media: { url: imageUrl }, description: course.title }] });
  }

  components.push({ type: 10, content: `<t:${Math.floor(Date.now() / 1000)}:d>, <t:${Math.floor(Date.now() / 1000)}:t>` });
  components.push(memberActions.toJSON(), managerActions.toJSON());

  return {
    allowedMentions: { parse: [] as never[] },
    components: [{ type: 17, accent_color: color(course.color || config.accentColor), components }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function formatInstructor(course: PoliceCourse) {
  const mention = course.instructorId ? `<@${course.instructorId}>` : escapeMarkdown(course.instructorName || "A definir");
  return course.instructorId ? `${mention} | ${course.instructorId}` : mention;
}

function formatSchedule(course: PoliceCourse) {
  const date = course.date && course.date !== "A definir" ? course.date : "A definir";
  const time = course.time && course.time !== "A definir" ? course.time : "A definir";
  return `${escapeMarkdown(date)} | ${escapeMarkdown(time)} | tarde`;
}

function courseStatusLine(course: PoliceCourse) {
  if (course.status === "finished") return "🔒 **STATUS**\nCurso finalizado.";
  if (course.status === "canceled") return "🔒 **STATUS**\nCurso cancelado.";
  if (course.status === "in_progress") return "▶️ **STATUS**\nCurso em andamento.";
  return "";
}

function configPanel(config: PoliceCourseConfig, courses: PoliceCourse[], notice?: string) {
  const managerRoles = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}:manager_roles`).setPlaceholder("Cargos que gerenciam cursos").setMinValues(0).setMaxValues(10);
  const finishRoles = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}:finish_roles`).setPlaceholder("Cargos que finalizam ou cancelam").setMinValues(0).setMaxValues(10);
  const managerUsers = new UserSelectMenuBuilder().setCustomId(`${PREFIX}:manager_users`).setPlaceholder("Administrador Geral da Unidade").setMinValues(0).setMaxValues(25);
  const create = new ButtonBuilder().setCustomId(`${PREFIX}:create`).setLabel("Cadastrar Curso").setEmoji("➕").setStyle(ButtonStyle.Primary);
  const save = new ButtonBuilder().setCustomId(`${PREFIX}:config_save`).setLabel("Salvar Config").setEmoji("💾").setStyle(ButtonStyle.Success);
  const courseSelect = courses.length
    ? new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}:config_select`)
        .setPlaceholder("Editar curso cadastrado")
        .addOptions(courses.slice(0, 25).map((course) => ({ label: course.title.slice(0, 100), value: course.id })))
    ).toJSON()
    : null;
  return {
    components: [{ type: 17, accent_color: color(config.accentColor), components: [
      { type: 10, content: "# Cursos / Treinamentos\nCadastre cursos e defina os cargos autorizados. Configuracoes avancadas e upload de banner ficam sincronizados pela dashboard." },
      ...(notice ? [{ type: 10, content: `✅ ${notice}` }] : []),
      new ActionRowBuilder<ButtonBuilder>().addComponents(create, save).toJSON(),
      ...(courseSelect ? [courseSelect] : []),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(managerUsers).toJSON(),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(managerRoles).toJSON(),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(finishRoles).toJSON()
    ] }]
  };
}

function configureCoursePanel(course: PoliceCourse, notice?: string) {
  const roles = new RoleSelectMenuBuilder()
    .setCustomId(`${PREFIX}:course_roles:${course.id}`)
    .setPlaceholder("Cargos de instrutor")
    .setMinValues(0)
    .setMaxValues(25);
  const users = new UserSelectMenuBuilder()
    .setCustomId(`${PREFIX}:course_users:${course.id}`)
    .setPlaceholder("Instrutores específicos")
    .setMinValues(0)
    .setMaxValues(25);
  const channel = new ChannelSelectMenuBuilder()
    .setCustomId(`${PREFIX}:course_channel:${course.id}`)
    .setPlaceholder("Canal do painel")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(0)
    .setMaxValues(1);
  const save = new ButtonBuilder()
    .setCustomId(`${PREFIX}:course_save:${course.id}`)
    .setLabel("Salvar")
    .setEmoji("💾")
    .setStyle(ButtonStyle.Success);
  const back = new ButtonBuilder()
    .setCustomId(`${PREFIX}:config_back`)
    .setLabel("Voltar")
    .setEmoji("⬅️")
    .setStyle(ButtonStyle.Secondary);
  return {
    components: [{ type: 17, accent_color: 0x2563eb, components: [
      { type: 10, content: `# Curso cadastrado\n**${escapeMarkdown(course.title)}**\nDefina os cargos, usuários instrutores e o canal do painel. O banner pode ser enviado pela dashboard.` },
      ...(notice ? [{ type: 10, content: `✅ ${notice}` }] : []),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roles).toJSON(),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(users).toJSON(),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channel).toJSON(),
      new ActionRowBuilder<ButtonBuilder>().addComponents(save, back).toJSON()
    ] }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function courseSessionModal(action: "start_submit" | "edit_submit", courseId: string, course: PoliceCourse) {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}:${action}:${courseId}`)
    .setTitle(action === "start_submit" ? "Iniciar curso" : "Editar curso")
    .addComponents(
      inputValueRow("date", "Data do curso", course.date === "A definir" ? "" : course.date, "Ex: 25/07/2026"),
      inputValueRow("time", "Horário do curso", course.time === "A definir" ? "" : course.time, "Ex: 20:00"),
      inputValueRow("maxSlots", "Quantidade máxima de alunos", course.maxSlots ? String(course.maxSlots) : "", "Ex: 10"),
      inputValueRow("location", "Local do curso", course.location === "A definir" ? "" : course.location, "Ex: Base Aérea")
    );
}

async function sendCourseLog(guild: Interaction["guild"] & {}, config: PoliceCourseConfig, course: PoliceCourse, action: string, actorId: string | null) {
  if (!config.logChannelId) return;
  await sendPoliceLog(guild, [config.logChannelId], {
    action,
    actorId,
    channelId: course.panelChannelId,
    color: color(course.color || config.accentColor),
    fields: [
      { name: "Curso", value: escapeMarkdown(course.title) },
      { name: "ID do Curso", value: escapeMarkdown(course.courseNumber) },
      { name: "Instrutor", value: course.instructorId ? `<@${course.instructorId}> | ${course.instructorId}` : "Não definido" },
      { name: "Status", value: course.status },
      { name: "Participantes", value: `${course.participants.length}${course.maxSlots ? `/${course.maxSlots}` : ""}` }
    ],
    id: course.id,
    image: course.bannerUrl && course.imagePosition !== "none"
      ? { imageEnabled: true, imagePosition: course.imagePosition, imageUrl: resolvePanelImageUrl(course.bannerUrl) }
      : null,
    title: "Curso"
  });
}

function canManage(member: GuildMember, ownerId: string, configOrRoleIds: PoliceCourseConfig | string[]) {
  const roleIds = Array.isArray(configOrRoleIds)
    ? configOrRoleIds
    : [
      ...configOrRoleIds.allowedManagerRoles,
      ...configOrRoleIds.createRoleIds,
      ...configOrRoleIds.editRoleIds,
      ...configOrRoleIds.deleteRoleIds
    ];
  const userIds = Array.isArray(configOrRoleIds) ? [] : configOrRoleIds.generalManagerUserIds;
  return member.id === ownerId || userIds.includes(member.id) || member.permissions.has(PermissionFlagsBits.Administrator) || roleIds.some((roleId) => member.roles.cache.has(roleId));
}
function canTeach(member: GuildMember, ownerId: string, config: PoliceCourseConfig, course: PoliceCourse) {
  return canManage(member, ownerId, config)
    || course.createdBy === member.id
    || course.authorizedUserIds.includes(member.id)
    || course.authorizedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}
function canStartCourse(course: PoliceCourse) {
  return course.status === "draft"
    || course.status === "finished"
    || course.status === "canceled"
    || (course.status === "open" && course.participants.length === 0);
}
function canControlCourse(member: GuildMember, ownerId: string, config: PoliceCourseConfig, course: PoliceCourse) {
  return member.id === course.instructorId
    || course.authorizedUserIds.includes(member.id)
    || canManage(member, ownerId, {
      ...config,
      allowedManagerRoles: [
        ...config.allowedManagerRoles,
        ...config.allowedFinishRoles,
        ...config.cancelRoleIds,
        ...config.concludeRoleIds,
        ...config.approveRoleIds
      ]
    });
}
function inputRow(id: string, label: string, style: TextInputStyle, required: boolean) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(style === TextInputStyle.Paragraph ? 1000 : 100));
}
function inputValueRow(id: string, label: string, value: string, placeholder: string) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100)
    .setPlaceholder(placeholder);
  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}
function color(value: string) { return Number.parseInt(value.replace("#", ""), 16) || 0x2563eb; }
function escapeMarkdown(value: string) { return value.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1"); }
