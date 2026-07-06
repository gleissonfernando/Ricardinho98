import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, MessageFlags, ModalBuilder,
    PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
    type ButtonInteraction, type ChatInputCommandInteraction, type Client, type GuildMember, type Interaction,
    type Message, type ModalSubmitInteraction, type StringSelectMenuInteraction, type UserSelectMenuInteraction
} from "discord.js";
import { isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";
import type { PolicePatrolMessage, PolicePatrolReport, PolicePatrolSettings } from "./apiClient";
import { renderComponentsV2Panel, type PanelVisualConfig } from "./panelVisualRenderer";

const PREFIX = "police_patrol";
const CONFIG_PREFIX = "police_patrol_config";
const DEFAULT_REPORT_QUESTIONS = [
  "Nome do policial", "ID/passaporte", "Cargo/patente", "Unidade",
  "Horario de inicio do patrulhamento", "Horario de termino do patrulhamento",
  "Quantidade de abordagens", "Quantidade de prisoes", "Quantidade de multas",
  "Quantidade de apreensoes", "Ocorrencias atendidas", "Com quem patrulhou",
  "Descreva um pouco como foi o patrulhamento"
];

export function startPolicePatrolReportService(client: Client, context: BotContext) {
  if (!isBotModuleEnabled("police-patrol-reports")) return;
  void cleanupDueChannels(client, context);
  const interval = setInterval(() => void cleanupDueChannels(client, context), 30_000); interval.unref();
}

export async function createPolicePatrolFromCommand(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return;
  const settings = await context.api.getPolicePatrolSettings(interaction.guild.id);
  const author = await interaction.guild.members.fetch(interaction.user.id);
  if (!settings.enabled) { await interaction.reply({ content: "Relatórios policiais estão desativados.", ephemeral: true }); return; }
  if (!hasRoleOrAdmin(author, settings.creatorRoleIds)) { await interaction.reply({ content: "Você não possui o cargo autorizado para criar relatórios.", ephemeral: true }); return; }
  const commandChannelIds = ids(settings.commandChannelIds, settings.commandChannelId);
  if (commandChannelIds.length && !commandChannelIds.includes(interaction.channelId)) { await interaction.reply({ content: `Use o comando /relatorio em ${commandChannelIds.map((id) => `<#${id}>`).join(", ")}.`, ephemeral: true }); return; }
  const officer = interaction.options.getUser("usuario", true);
  await interaction.guild.members.fetch(officer.id);
  const patrolType = interaction.options.getString("tipo"); const initialNotes = interaction.options.getString("observacoes");
  await interaction.deferReply({ ephemeral: true });
  const report = await context.api.createPolicePatrolReport({ guildId: interaction.guild.id, officerId: officer.id, officerName: officer.globalName ?? officer.username, authorId: interaction.user.id, authorName: author.displayName, patrolType, initialNotes });
  if (report.channelId) { await interaction.editReply(`Já existe um relatório aberto em <#${report.channelId}>.`); return; }
  const overwrites: any[] = [
    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] },
    { id: officer.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
    ...settings.supervisorRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }))
  ];
  const channel = await interaction.guild.channels.create({ name: `relatorio-${slug(officer.username)}-${report.id.slice(0, 4)}`, type: ChannelType.GuildText, parent: ids(settings.temporaryCategoryIds, settings.temporaryCategoryId)[0] ?? undefined, permissionOverwrites: overwrites, reason: `Relatório policial ${report.id}` });
  const visuals = await getPanelVisualSlots(context, interaction.guild.id, "police-patrol-reports");
  const panel = await channel.send(initialPanel(report, visuals));
  await context.api.setPolicePatrolChannel(report.id, channel.id, panel.id);
  await interaction.editReply(`Canal criado: <#${channel.id}>.`);
}

export async function showPolicePatrolViewer(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return;
  const settings = await context.api.getPolicePatrolSettings(interaction.guild.id); const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasRoleOrAdmin(member, settings.viewerRoleIds)) { await interaction.reply({ content: "Você não possui permissão para visualizar todos os relatórios.", ephemeral: true }); return; }
  const select = new UserSelectMenuBuilder().setCustomId(`${PREFIX}:officer`).setPlaceholder("Escolha um policial").setMinValues(1).setMaxValues(1);
  await interaction.reply({ components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: "# 📋 Consultar Relatórios Policiais\nEscolha o policial para ver relatórios e estatísticas." }, new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

export async function handlePolicePatrolInteraction(interaction: Interaction, context: BotContext) {
  if ("customId" in interaction && interaction.customId.startsWith(`${CONFIG_PREFIX}:`)) {
    await handlePolicePatrolConfigInteraction(interaction, context);
    return true;
  }
  if (!(interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  const [, action, reportId] = interaction.customId.split(":");
  if (interaction.isButton() && action === "start") await showStartModal(interaction, reportId!);
  else if (interaction.isModalSubmit() && action === "start_modal") await startReport(interaction, context, reportId!);
  else if (interaction.isButton() && action === "finish") await showFinishModal(interaction, reportId!);
  else if (interaction.isModalSubmit() && action === "finish_modal") await finishReport(interaction, context, reportId!);
  else if (interaction.isButton() && action === "continue") await interaction.reply({ content: "Continue enviando mensagens neste canal. Tudo será salvo automaticamente.", ephemeral: true });
  else if (interaction.isButton() && action === "cancel") await cancelReport(interaction, context, reportId!);
  else if (interaction.isUserSelectMenu() && action === "officer") await selectOfficer(interaction, context);
  else if (interaction.isStringSelectMenu() && action === "report") await showReport(interaction, context, interaction.values[0]!);
  else if (interaction.isButton() && action === "report_page") await showReportPage(interaction, context, reportId!);
  else if (interaction.isButton() && action === "view") await showReport(interaction, context, reportId!);
  else if (interaction.isButton() && action === "export") await exportDefaultReport(interaction, context, reportId!);
  else if (interaction.isButton() && action && ["html", "json", "pdf"].includes(action)) await exportReport(interaction, context, reportId!, action as "html" | "json" | "pdf");
  else if (interaction.isButton() && action === "delete") await deleteReport(interaction, context, reportId!);
  else if (interaction.isButton() && (action === "approve" || action === "reject")) await evaluateReport(interaction, context, reportId!, action === "approve" ? "approved" : "rejected");
  return true;
}

export async function showPolicePatrolConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) return;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Voce precisa de permissao para gerenciar o servidor.", ephemeral: true });
    return;
  }

  await Promise.all([
    interaction.guild.members.fetch(),
    interaction.guild.roles.fetch(),
    interaction.guild.channels.fetch()
  ]);
  const settings = await context.api.getPolicePatrolSettings(interaction.guild.id);
  await interaction.reply(configPanelPayload(settings));
}

async function handlePolicePatrolConfigInteraction(interaction: Interaction, context: BotContext) {
  if (!interaction.guildId || !interaction.isRepliable() || !("customId" in interaction)) return;
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Voce nao possui permissao para configurar relatorios.", ephemeral: true });
    return;
  }

  const settings = await context.api.getPolicePatrolSettings(interaction.guildId);
  const [, action, target] = interaction.customId.split(":");

  if (interaction.isButton() && action === "toggle") {
    const saved = await context.api.savePolicePatrolSettings(interaction.guildId, { actorId: interaction.user.id, enabled: !settings.enabled });
    await interaction.update(configPanelPayload(saved));
    return;
  }

  if (interaction.isStringSelectMenu() && action === "menu") {
    await interaction.reply(configEditorPayload(interaction.values[0] ?? "general", settings));
    return;
  }

  if (interaction.isChannelSelectMenu() && action === "channel") {
    const channelIds = interaction.values;
    const patch = target === "command" ? { commandChannelIds: channelIds } : target === "log" ? { logChannelIds: channelIds } : target === "temporary" ? { temporaryCategoryIds: channelIds } : { archiveCategoryIds: channelIds };
    await context.api.savePolicePatrolSettings(interaction.guildId, { actorId: interaction.user.id, ...patch });
    await interaction.update(configSavedPayload("Canal salvo. Abra /config relatorio novamente para ver o resumo atualizado."));
    return;
  }

  if (interaction.isRoleSelectMenu() && action === "roles") {
    const values = interaction.values;
    const patch = target === "creator" ? { creatorRoleIds: values } : target === "viewer" ? { viewerRoleIds: values } : target === "delete" ? { deleteRoleIds: values } : target === "archive" ? { archiveViewRoleIds: values } : { supervisorRoleIds: values };
    await context.api.savePolicePatrolSettings(interaction.guildId, { actorId: interaction.user.id, ...patch });
    await interaction.update(configSavedPayload("Cargos salvos. Abra /config relatorio novamente para ver o resumo atualizado."));
    return;
  }

  if (interaction.isStringSelectMenu() && action === "export") {
    await context.api.savePolicePatrolSettings(interaction.guildId, { actorId: interaction.user.id, defaultExportFormat: interaction.values[0] as PolicePatrolSettings["defaultExportFormat"] });
    await interaction.update(configSavedPayload("Formato de exportacao salvo."));
    return;
  }

  if (interaction.isStringSelectMenu() && action === "delete_delay") {
    await context.api.savePolicePatrolSettings(interaction.guildId, { actorId: interaction.user.id, deleteDelayMinutes: Number(interaction.values[0] ?? settings.deleteDelayMinutes) });
    await interaction.update(configSavedPayload("Tempo de exclusao salvo."));
  }
}

export async function capturePolicePatrolMessage(message: Message, context: BotContext) {
  if (!isBotModuleEnabled("police-patrol-reports") || !message.guild || message.author.bot) return false;
  const report = await context.api.getPolicePatrolReportByChannel(message.channel.id).catch(() => null);
  if (!report || report.officerId !== message.author.id) return false;
  const attachments = await Promise.all([...message.attachments.values()].map(async (item) => {
    try { const response = await fetch(item.url); if (!response.ok) throw new Error(`HTTP ${response.status}`); const stored = await context.api.storePolicePatrolAttachment(report.id, item.id, item.name, item.contentType ?? "application/octet-stream", Buffer.from(await response.arrayBuffer())); return { id: item.id, name: item.name, url: stored.url, contentType: item.contentType, size: item.size }; }
    catch (error) { console.warn(`[police-patrol] anexo ${item.id} não pôde ser persistido:`, error instanceof Error ? error.message : error); return { id: item.id, name: item.name, url: item.url, contentType: item.contentType, size: item.size }; }
  }));
  await context.api.appendPolicePatrolMessage(report.id, {
    discordMessageId: message.id, authorId: message.author.id, content: message.content,
    attachments,
    embeds: message.embeds.map((item) => item.toJSON()), stickers: [...message.stickers.values()].map((item) => ({ id: item.id, name: item.name, format: item.format })),
    emojis: [...new Set(message.content.match(/<a?:\w+:\d+>|\p{Extended_Pictographic}/gu) ?? [])], createdAt: message.createdAt.toISOString()
  });
  return true;
}

async function showStartModal(interaction: ButtonInteraction, reportId: string) {
  const modal = new ModalBuilder().setCustomId(`${PREFIX}:start_modal:${reportId}`).setTitle("Iniciar relatório").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("start").setLabel("Início do patrulhamento (HH:mm)").setStyle(TextInputStyle.Short).setPlaceholder("08:30").setRequired(true)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("end").setLabel("Final do patrulhamento (HH:mm)").setStyle(TextInputStyle.Short).setPlaceholder("11:10").setRequired(true))
  ); await interaction.showModal(modal);
}

async function startReport(interaction: ModalSubmitInteraction, context: BotContext, reportId: string) {
  await interaction.deferReply({ ephemeral: true });
  const report = await context.api.startPolicePatrolReport(reportId, { actorId: interaction.user.id, patrolStart: interaction.fields.getTextInputValue("start").trim(), patrolEnd: interaction.fields.getTextInputValue("end").trim() });
  await updatePanel(interaction, activePanel(report));
  await interaction.editReply("Agora descreva tudo que aconteceu. Envie quantas mensagens desejar; todas serão salvas automaticamente.");
}

async function showFinishModal(interaction: ButtonInteraction, reportId: string) {
  const modal = new ModalBuilder().setCustomId(`${PREFIX}:finish_modal:${reportId}`).setTitle("Encerrar relatório").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Motivo do encerramento (opcional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Ex.: relatório concluído, sem pendências."))
  );
  await interaction.showModal(modal);
}

async function finishReport(interaction: ButtonInteraction | ModalSubmitInteraction, context: BotContext, reportId: string) {
  await interaction.deferReply({ ephemeral: true }); const settings = await context.api.getPolicePatrolSettings(interaction.guildId!);
  const archiveReason = interaction.isModalSubmit() ? normalizeArchiveReason(interaction.fields.getTextInputValue("reason")) : null;
  const data = await context.api.finishPolicePatrolReport(reportId, interaction.user.id, settings.deleteDelayMinutes, archiveReason);
  if (data.report.lastAuthorMessageId && interaction.channel?.isTextBased()) { const message = await interaction.channel.messages.fetch(data.report.lastAuthorMessageId).catch(() => null); await message?.react("👍").catch(() => null); }
  const guild = interaction.guild;
  const channel = data.report.channelId ? await guild?.channels.fetch(data.report.channelId).catch(() => null) : null;
  if (guild && channel && channel.isTextBased() && "permissionOverwrites" in channel) {
    const overwriteManager = channel.permissionOverwrites;
    await overwriteManager.edit(guild.roles.everyone.id, { ViewChannel: false, ReadMessageHistory: false, SendMessages: false }).catch(() => null);
    await overwriteManager.edit(data.report.authorId, { ViewChannel: false, ReadMessageHistory: false, SendMessages: false }).catch(() => null);
    await overwriteManager.edit(data.report.officerId, { ViewChannel: false, ReadMessageHistory: false, SendMessages: false }).catch(() => null);
    for (const roleId of settings.archiveViewRoleIds) { await overwriteManager.edit(roleId, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }).catch(() => null); }
    await overwriteManager.edit(interaction.client.user.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true }).catch(() => null);
    const archiveCategoryId = ids(settings.archiveCategoryIds, settings.archiveCategoryId)[0] ?? null;
    if (archiveCategoryId) { await channel.setParent(archiveCategoryId, { lockPermissions: false }).catch(() => null); }
  }
  await updatePanel(interaction, finishedPanel(data.report));
  await sendLog(interaction, context, settings, data.report, data.messages);
  await interaction.deleteReply().catch(() => null);
}

async function cancelReport(interaction: ButtonInteraction, context: BotContext, reportId: string) { await interaction.deferReply({ ephemeral: true }); const settings = await context.api.getPolicePatrolSettings(interaction.guildId!); const report = await context.api.cancelPolicePatrolReport(reportId, interaction.user.id, settings.deleteDelayMinutes); await updatePanel(interaction, finishedPanel(report)); await interaction.editReply("Relatório cancelado."); }

async function selectOfficer(interaction: UserSelectMenuInteraction, context: BotContext) {
  await interaction.deferUpdate(); const officerId = interaction.values[0]!; const reports = (await context.api.listPolicePatrolReports(interaction.guildId!, officerId)).filter((item) => item.status === "finished");
  if (!reports.length) { await interaction.editReply({ components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: "Nenhum relatório finalizado para este policial." }] }] }); return; }
  const total = reports.reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0); const authors = new Set(reports.map((item) => item.authorId)).size;
  const select = reportSelect(reports.slice(0, 25)); const navigation = reports.length > 25 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:report_page:${officerId}|1`).setLabel("Próxima página").setStyle(ButtonStyle.Secondary))] : [];
  await interaction.editReply({ components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: `# Estatísticas de <@${officerId}>\n**Total:** ${reports.length}\n**Autores diferentes:** ${authors}\n**Tempo patrulhado:** ${duration(total)}\n**Último:** <t:${Math.floor(Date.parse(reports[0]!.createdAt) / 1000)}:D>\n**Primeiro:** <t:${Math.floor(Date.parse(reports[reports.length - 1]!.createdAt) / 1000)}:D>` }, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), ...navigation] }], flags: MessageFlags.IsComponentsV2 });
}

async function showReportPage(interaction: ButtonInteraction, context: BotContext, token: string) { await interaction.deferUpdate(); const [officerId, rawPage] = token.split("|"); const reports = (await context.api.listPolicePatrolReports(interaction.guildId!, officerId)).filter((item) => item.status === "finished"); const pages = Math.max(1, Math.ceil(reports.length / 25)); const page = Math.min(pages - 1, Math.max(0, Number(rawPage) || 0)); const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:report_page:${officerId}|${page - 1}`).setLabel("Anterior").setStyle(ButtonStyle.Secondary).setDisabled(page === 0), new ButtonBuilder().setCustomId(`${PREFIX}:report_page:${officerId}|${page + 1}`).setLabel("Próxima").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)); await interaction.editReply({ components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: `# Relatórios de <@${officerId}>\nPágina ${page + 1}/${pages}` }, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(reportSelect(reports.slice(page * 25, page * 25 + 25))), navigation] }], flags: MessageFlags.IsComponentsV2 }); }
function reportSelect(reports: PolicePatrolReport[]) { return new StringSelectMenuBuilder().setCustomId(`${PREFIX}:report`).setPlaceholder("Escolha um relatório").addOptions(reports.map((item) => ({ label: `Relatório • ${item.officerName}`.slice(0, 100), description: `por ${item.authorName} • ${duration(item.durationMinutes)}`.slice(0, 100), value: item.id }))); }

async function showReport(interaction: StringSelectMenuInteraction | ButtonInteraction, context: BotContext, reportId: string) { if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }); const data = await context.api.getPolicePatrolReport(reportId); if (!(await canViewReport(interaction, context, data.report))) { await interaction.editReply("Você não possui permissão para visualizar este relatório."); return; } const text = reportText(data.report, data.messages); const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:pdf:${reportId}`).setLabel("Exportar PDF").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`${PREFIX}:html:${reportId}`).setLabel("Exportar HTML").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`${PREFIX}:json:${reportId}`).setLabel("Exportar JSON").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`${PREFIX}:delete:${reportId}`).setLabel("Excluir").setStyle(ButtonStyle.Danger)); await interaction.editReply({ components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: text.slice(0, 3900) }, buttons] }], flags: MessageFlags.IsComponentsV2 }); }

async function exportReport(interaction: ButtonInteraction, context: BotContext, reportId: string, format: "html" | "json" | "pdf") { await interaction.deferReply({ ephemeral: true }); const data = await context.api.getPolicePatrolReport(reportId); if (!(await canViewReport(interaction, context, data.report))) { await interaction.editReply("Você não possui permissão para exportar este relatório."); return; } const base = `relatorio-${data.report.id.slice(0, 8)}`; const content = format === "json" ? Buffer.from(JSON.stringify(data, null, 2)) : format === "html" ? Buffer.from(reportHtml(data.report, data.messages)) : makePdf(reportText(data.report, data.messages)); await interaction.editReply({ files: [new AttachmentBuilder(content, { name: `${base}.${format}` })] }); }
async function exportDefaultReport(interaction: ButtonInteraction, context: BotContext, reportId: string) { const settings = await context.api.getPolicePatrolSettings(interaction.guildId!); await exportReport(interaction, context, reportId, settings.defaultExportFormat); }

async function deleteReport(interaction: ButtonInteraction, context: BotContext, reportId: string) { const settings = await context.api.getPolicePatrolSettings(interaction.guildId!); const member = interaction.member as GuildMember; if (!hasRoleOrAdmin(member, settings.deleteRoleIds)) { await interaction.reply({ content: "Somente administradores autorizados podem excluir.", ephemeral: true }); return; } await context.api.deletePolicePatrolReport(reportId, interaction.user.id); await interaction.reply({ content: "Relatório excluído permanentemente.", ephemeral: true }); }

async function evaluateReport(interaction: ButtonInteraction, context: BotContext, reportId: string, result: "approved" | "rejected") {
  const settings = await context.api.getPolicePatrolSettings(interaction.guildId!);
  if (!hasRoleOrAdmin(interaction.member as GuildMember, settings.supervisorRoleIds)) {
    await interaction.reply({ content: "Voce nao possui cargo autorizado para avaliar relatorios.", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  const report = await context.api.evaluatePolicePatrolReport(reportId, interaction.user.id, result);
  await interaction.message.edit(evaluationLogPayload(report));
}

async function sendLog(interaction: ButtonInteraction | ModalSubmitInteraction, context: BotContext, settings: PolicePatrolSettings, report: PolicePatrolReport, messages: PolicePatrolMessage[]) {
  const logChannelId = ids(settings.logChannelIds, settings.logChannelId)[0] ?? null;
  if (!logChannelId || !interaction.guild) return;
  const channel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  const visuals = await getPanelVisualSlots(context, interaction.guild.id, "police-patrol-reports");
  await channel.send(pendingLogPayload(interaction.guild.name, report, messages, visuals[0] ?? null));
}

function pendingLogPayload(guildName: string, report: PolicePatrolReport, messages: PolicePatrolMessage[], image: PanelVisualConfig | null) {
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:approve:${report.id}`).setLabel("Aprovar relatorio").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:reject:${report.id}`).setLabel("Reprovar relatorio").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}:view:${report.id}`).setLabel("Ver completo").setStyle(ButtonStyle.Secondary)
  );
  return renderComponentsV2Panel({
    accentColor: 0xf59e0b,
    actions: [actions],
    description: "",
    fields: [
      `**Usuario**\n<@${report.authorId}>\nID do Usuário: ${report.authorId}`,
      `**Registro**\nRelatório finalizado para avaliação`,
      `**Policial**\n<@${report.officerId}> | ${report.officerId}`,
      `**Resumo**\nMensagens: ${report.messageCount}\nAnexos: ${report.attachmentCount}\nTempo: ${duration(report.durationMinutes)}\nStatus: Pendente de avaliação`,
      `**Canal**\n${report.channelId ? `<#${report.channelId}>` : "Canal não informado"}\nServerId: ${guildName}`,
      `**Descrição**\n${reportText(report, messages).slice(0, 1200)}`
    ],
    footerText: `-# ID do registro: ${report.id} - ${formatLogDate(new Date())}`,
    image,
    moduleId: "police-patrol-reports",
    title: "Registro de Relatório"
  });
}

function evaluationLogPayload(report: PolicePatrolReport) {
  const approved = report.evaluationStatus === "approved";
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:approve:${report.id}`).setLabel("Aprovar relatorio").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PREFIX}:reject:${report.id}`).setLabel("Reprovar relatorio").setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PREFIX}:view:${report.id}`).setLabel("Ver completo").setStyle(ButtonStyle.Secondary)
  );
  const details = `# Relatorio ${approved ? "aprovado" : "reprovado"}\n**Responsavel:** <@${report.officerId}>\n**Solicitado por:** <@${report.authorId}>\n**Status:** ${approved ? "Aprovado" : "Reprovado"}\n**Avaliacao:** ${report.evaluationMessage}\n**Avaliado por:** <@${report.evaluatedBy}>\n**Data da avaliacao:** <t:${Math.floor(Date.parse(report.evaluatedAt ?? new Date().toISOString()) / 1000)}:F>`;
  return { components: [{ type: 17, accent_color: approved ? 0x22c55e : 0xef4444, components: [{ type: 10, content: details }, actions] }], flags: MessageFlags.IsComponentsV2 as const };
}

async function updatePanel(interaction: any, payload: any) { if (!interaction.message) return; await interaction.message.edit(payload).catch(() => null); }
async function cleanupDueChannels(client: Client, context: BotContext) { const reports = await context.api.getPolicePatrolChannelsDue().catch(() => []); for (const report of reports) { if (!report.channelId) continue; const guild = await client.guilds.fetch(report.guildId).catch(() => null); const channel = await guild?.channels.fetch(report.channelId).catch(() => null); await channel?.delete(`Relatório ${report.status} arquivado`).catch(() => null); await context.api.clearPolicePatrolChannel(report.id).catch(() => null); } }

async function getPanelVisualSlots(context: BotContext, guildId: string, basePanelId: string) {
  const panelIds = [basePanelId, `${basePanelId}-banner-2`, `${basePanelId}-banner-3`];
  const visuals = await Promise.all(panelIds.map((panelId) => context.api.getPanelVisualSettings(guildId, panelId).catch(() => null)));

  return visuals.flatMap((visual, index): PanelVisualConfig[] => {
    if (!visual?.imageEnabled) return [];
    if (index > 0 && visual.useGlobalDefault) return [];
    return [{ imageEnabled: visual.imageEnabled, imagePosition: visual.imagePosition, imageUrl: visual.imageUrl }];
  });
}

export function normalizeArchiveReason(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function configPanelPayload(settings: PolicePatrolSettings) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CONFIG_PREFIX}:menu`)
    .setPlaceholder("Selecione o que deseja configurar")
    .addOptions(
      { label: "Canal do /relatorio", value: "command_channel", description: "Onde o comando podera ser utilizado" },
      { label: "Canal de logs", value: "log_channel", description: "Onde relatorios finalizados serao enviados" },
      { label: "Categorias", value: "categories", description: "Canais temporarios e arquivo" },
      { label: "Permissoes", value: "permissions", description: "Cargos autorizados do sistema policial" },
      { label: "Exclusao automatica", value: "delete_delay", description: "Tempo para limpeza de canais cancelados" },
      { label: "Exportacao", value: "export", description: "Formato padrao HTML, PDF ou JSON" }
    );
  const toggle = new ButtonBuilder()
    .setCustomId(`${CONFIG_PREFIX}:toggle`)
    .setLabel(settings.enabled ? "Desativar sistema" : "Ativar sistema")
    .setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success);

  return {
    components: [{
      type: 17,
      accent_color: 0x2563eb,
      components: [
        { type: 10, content: `# Sistema de Relatorios\nStatus: **${settings.enabled ? "Ativo" : "Inativo"}**\nCanais do comando: ${formatMentions(ids(settings.commandChannelIds, settings.commandChannelId), "Nao definido")}\nLogs: ${formatMentions(ids(settings.logChannelIds, settings.logChannelId), "Nao definido")}\nCategorias temporarias: ${ids(settings.temporaryCategoryIds, settings.temporaryCategoryId).join(", ") || "Nao definida"}\nExportacao padrao: **${settings.defaultExportFormat.toUpperCase()}**` },
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(toggle)
      ]
    }],
    ephemeral: true,
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function configEditorPayload(section: string, settings: PolicePatrolSettings) {
  if (section === "command_channel") return channelEditor("Canal de execucao do /relatorio", "command", ChannelType.GuildText);
  if (section === "log_channel") return channelEditor("Canal de logs dos relatorios", "log", ChannelType.GuildText);
  if (section === "categories") {
    return {
      components: [{
        type: 17,
        accent_color: 0x2563eb,
        components: [
          { type: 10, content: "# Categorias\nConfigure onde os canais temporarios serao criados e para onde serao arquivados." },
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${CONFIG_PREFIX}:channel:temporary`).setPlaceholder("Categorias temporarias").setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(25)),
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${CONFIG_PREFIX}:channel:archive`).setPlaceholder("Categorias de arquivo").setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(25))
        ]
      }],
      ephemeral: true,
      flags: MessageFlags.IsComponentsV2 as const
    };
  }
  if (section === "permissions") {
    return {
      components: [{
        type: 17,
        accent_color: 0x2563eb,
        components: [
          { type: 10, content: "# Permissoes\nSelecione cargos para criar, visualizar, excluir e acessar canais de relatorio." },
          roleEditor("Cargos que criam relatorios", "creator", settings.creatorRoleIds),
          roleEditor("Cargos que visualizam todos", "viewer", settings.viewerRoleIds),
          roleEditor("Cargos que excluem relatorios", "delete", settings.deleteRoleIds),
          roleEditor("Cargos nos canais temporarios", "supervisor", settings.supervisorRoleIds),
          roleEditor("Cargos que veem arquivo", "archive", settings.archiveViewRoleIds)
        ]
      }],
      ephemeral: true,
      flags: MessageFlags.IsComponentsV2 as const
    };
  }
  if (section === "delete_delay") {
    return stringSelectEditor("Exclusao automatica", "delete_delay", [
      { label: "Nunca excluir automaticamente", value: "0" },
      { label: "5 minutos", value: "5" },
      { label: "30 minutos", value: "30" },
      { label: "1 hora", value: "60" },
      { label: "24 horas", value: "1440" }
    ]);
  }
  return stringSelectEditor("Exportacao padrao", "export", [
    { label: "HTML", value: "html" },
    { label: "PDF", value: "pdf" },
    { label: "JSON", value: "json" }
  ]);
}

function channelEditor(title: string, target: string, type: ChannelType.GuildText | ChannelType.GuildCategory) {
  return {
    components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: `# ${title}` }, new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${CONFIG_PREFIX}:channel:${target}`).setPlaceholder(title).setChannelTypes(type).setMinValues(0).setMaxValues(25))] }],
    ephemeral: true,
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function roleEditor(placeholder: string, target: string, _defaults: string[]) {
  void _defaults;
  const menu = new RoleSelectMenuBuilder().setCustomId(`${CONFIG_PREFIX}:roles:${target}`).setPlaceholder(placeholder).setMinValues(0).setMaxValues(25);
  return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu);
}

function stringSelectEditor(title: string, action: string, options: Array<{ label: string; value: string }>) {
  return {
    components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: `# ${title}` }, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${CONFIG_PREFIX}:${action}`).setPlaceholder(title).addOptions(options))] }],
    ephemeral: true,
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function configSavedPayload(message: string) {
  return {
    components: [{ type: 17, accent_color: 0x22c55e, components: [{ type: 10, content: `# Configuracao salva\n${message}` }] }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function initialPanel(report: PolicePatrolReport, visuals: PanelVisualConfig[] = []) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:start:${report.id}`).setLabel("Iniciar Relatório").setEmoji("▶️").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`${PREFIX}:cancel:${report.id}`).setLabel("Cancelar Relatório").setEmoji("❌").setStyle(ButtonStyle.Danger));
  return renderComponentsV2Panel({
    accentColor: 0x2563eb,
    actions: [buttons],
    description: "Responda ao roteiro abaixo neste canal. Voce pode dividir as respostas em varias mensagens.",
    extraImages: visuals.slice(1),
    fields: [
      `**Responsável pelo preenchimento:** <@${report.officerId}>\n**Solicitado por:** <@${report.authorId}>\n\nQuando estiver pronto, clique em **Iniciar Relatório**.`,
      DEFAULT_REPORT_QUESTIONS.map((question, index) => `**${index + 1}. ${question}:**`).join("\n")
    ],
    image: visuals[0] ?? null,
    moduleId: "police-patrol-reports",
    title: "Relatório de Patrulhamento"
  });
}
function activePanel(report: PolicePatrolReport) { const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:finish:${report.id}`).setLabel("Finalizar Relatório").setEmoji("✅").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`${PREFIX}:continue:${report.id}`).setLabel("Continuar Escrevendo").setEmoji("📝").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`${PREFIX}:cancel:${report.id}`).setLabel("Cancelar").setEmoji("❌").setStyle(ButtonStyle.Danger)); return { components: [{ type: 17, accent_color: 0x2563eb, components: [{ type: 10, content: `# Relatório em andamento\n**Policial:** <@${report.officerId}>\n**Responsável:** <@${report.authorId}>\n**Horário:** ${report.patrolStart} até ${report.patrolEnd}\n\nEnvie quantas mensagens, imagens e anexos precisar.` }, buttons] }], flags: MessageFlags.IsComponentsV2 as const }; }
function finishedPanel(report: PolicePatrolReport) { return { components: [{ type: 17, accent_color: report.status === "finished" ? 0x22c55e : 0xef4444, components: [{ type: 10, content: `# Relatório ${report.status === "finished" ? "finalizado" : "cancelado"}\n**Policial:** <@${report.officerId}>\n**Responsável:** <@${report.authorId}>\n**Mensagens:** ${report.messageCount}\n**Tempo:** ${duration(report.durationMinutes)}` }] }], flags: MessageFlags.IsComponentsV2 as const }; }
function reportText(report: PolicePatrolReport, messages: PolicePatrolMessage[]) { return `# RELATÓRIO DE PATRULHAMENTO\n**Policial avaliado:** <@${report.officerId}>\n**Responsável:** <@${report.authorId}>\n**Início:** ${report.patrolStart ?? "-"}\n**Fim:** ${report.patrolEnd ?? "-"}\n**Tempo total:** ${duration(report.durationMinutes)}\n**Mensagens:** ${report.messageCount}\n**Anexos:** ${report.attachmentCount}\n\n## Descrição\n${messages.map((item) => `• ${item.content || "[mídia/anexo]"}${item.attachments.map((file) => `\n  ↳ ${file.url}`).join("")}${item.stickers.map((sticker) => `\n  ↳ Sticker: ${sticker.name}`).join("")}${item.embeds.length ? `\n  ↳ ${item.embeds.length} embed(s) armazenada(s)` : ""}`).join("\n\n") || "Sem descrição."}`; }
function reportHtml(report: PolicePatrolReport, messages: PolicePatrolMessage[]) { return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Relatório ${escapeHtml(report.id)}</title><style>body{font:16px Arial;max-width:900px;margin:40px auto;line-height:1.5}article{border-bottom:1px solid #ddd;padding:12px 0}img{max-width:100%}</style><h1>Relatório de Patrulhamento</h1><p><b>Policial:</b> ${escapeHtml(report.officerName)}<br><b>Responsável:</b> ${escapeHtml(report.authorName)}<br><b>Horário:</b> ${report.patrolStart ?? "-"}–${report.patrolEnd ?? "-"}<br><b>Tempo:</b> ${duration(report.durationMinutes)}</p>${messages.map((item) => `<article><time>${escapeHtml(item.createdAt)}</time><p>${escapeHtml(item.content).replace(/\n/g, "<br>")}</p>${item.attachments.map((file) => `<p><a href="${escapeHtml(file.url)}">${escapeHtml(file.name)}</a></p>`).join("")}</article>`).join("")}</html>`; }
function makePdf(text: string) { const lines = text.replace(/[^\x20-\x7e\n]/g, "?").split("\n").flatMap((line) => line.length ? line.match(/.{1,90}/g) ?? [line] : [""]); const pages = Array.from({ length: Math.max(1, Math.ceil(lines.length / 55)) }, (_, index) => lines.slice(index * 55, index * 55 + 55)); const fontId = 3 + pages.length * 2; const objects: string[] = ["1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj", ""]; const kids: number[] = []; pages.forEach((pageLines, index) => { const pageId = 3 + index * 2; const contentId = pageId + 1; kids.push(pageId); const stream = `BT /F1 10 Tf 50 790 Td ${pageLines.map((line, lineIndex) => `${lineIndex ? "0 -13 Td " : ""}(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join(" ")} ET`; objects.push(`${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >> endobj`, `${contentId} 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`); }); objects[1] = `2 0 obj << /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >> endobj`; objects.push(`${fontId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`); let pdf = "%PDF-1.4\n"; const offsets = [0]; for (const object of objects) { offsets.push(Buffer.byteLength(pdf)); pdf += `${object}\n`; } const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; return Buffer.from(pdf); }
async function canViewReport(interaction: ButtonInteraction | StringSelectMenuInteraction, context: BotContext, report: PolicePatrolReport) { if (interaction.user.id === report.authorId || interaction.user.id === report.officerId) return true; const settings = await context.api.getPolicePatrolSettings(interaction.guildId!); return hasRoleOrAdmin(interaction.member as GuildMember, settings.viewerRoleIds); }
function hasRoleOrAdmin(member: GuildMember, roleIds: string[]) { return member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild) || member.roles.cache.some((role) => roleIds.includes(role.id)); }
function ids(values: string[] | undefined, fallback: string | null | undefined) { return [...new Set([...(values ?? []), fallback].filter((value): value is string => typeof value === "string" && value.length > 0))]; }
function formatMentions(values: string[], fallback: string) { return values.length ? values.map((id) => `<#${id}>`).join(", ") : fallback; }
function formatLogDate(value: Date) { return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", hour: "2-digit", hour12: false, minute: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo", year: "numeric" }).format(value).replace(",", ""); }
function duration(minutes: number | null) { if (minutes === null) return "-"; return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`; }
function slug(value: string) { return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "policial"; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!)); }
