import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags,
  ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type Client, type GuildMember, type Interaction,
  type StringSelectMenuInteraction
} from "discord.js";
import { isBotModuleEnabled } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import type { FivemActionArchitecture, FivemActionSession, FivemActionSettings, FivemActionType } from "./apiClient";
import { resolvePanelImageUrl, type PanelVisualConfig } from "./panelVisualRenderer";

const PREFIX = "fivem_action";
const MODULE_BY_ARCHITECTURE: Record<FivemActionArchitecture, string> = { fac: "fivem-actions", police: "police-actions" };
const handledRequests = new Map<string, string>();
let polling = false;
let serviceStarted = false;

export const actionCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("acao")
    .setDescription("Sistema de ações com painel, participantes e resultado.")
    .addSubcommand((subcommand) => subcommand.setName("iniciar").setDescription("Abre o seletor de ações.").addStringOption((option) => option.setName("modulo").setDescription("Escolha qual Sistema de Ações usar.").addChoices({ name: "FAC", value: "fac" }, { name: "Polícia", value: "police" }).setRequired(false)))
    .addSubcommand((subcommand) => subcommand.setName("publicar").setDescription("Publica o painel principal no canal configurado.").addStringOption((option) => option.setName("modulo").setDescription("Escolha qual Sistema de Ações usar.").addChoices({ name: "FAC", value: "fac" }, { name: "Polícia", value: "police" }).setRequired(false)))
    .addSubcommand((subcommand) => subcommand.setName("config").setDescription("Mostra onde configurar canais, permissões, ações e estatísticas.").addStringOption((option) => option.setName("modulo").setDescription("Escolha qual Sistema de Ações usar.").addChoices({ name: "FAC", value: "fac" }, { name: "Polícia", value: "police" }).setRequired(false))),
  async execute(interaction, context) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: "Use este comando em um servidor.", ephemeral: true });
      return;
    }
    const architecture = architectureFromInteraction(interaction);
    if (!isFivemActionRuntimeEnabled(architecture)) {
      await interaction.reply({ content: "Sistema de Ações não liberado para este bot.", ephemeral: true });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "config") {
      await interaction.reply({ content: "Use a aba **Sistema de Ações** na dashboard para configurar ações, canais, permissões, banners, resultados, logs e estatísticas. As alterações ficam sincronizadas com o bot.", ephemeral: true });
      return;
    }
    const dashboard = await context.api.getFivemActionDashboard(interaction.guildId, architecture);
    if (subcommand === "publicar") {
      if (!dashboard.settings.enabled) { await interaction.reply({ content: "❌ Ative o Sistema de Ações na dashboard antes de publicar.", ephemeral: true }); return; }
      await publishMainPanel(interaction.client, context, dashboard.settings);
      await interaction.reply({ content: "✅ Painel de ações publicado/atualizado.", ephemeral: true });
      return;
    }
    const payload = actionSelectionPayload(dashboard.settings, dashboard.actions);
    if (!payload) { await interaction.reply({ content: "❌ Nenhuma ação foi cadastrada.", ephemeral: true }); return; }
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
  }
};

function architectureFromInteraction(interaction: any): FivemActionArchitecture {
  const selected = interaction.options.getString("modulo", false);
  if (selected === "fac" || selected === "police") return selected;
  return isFivemActionRuntimeEnabled("fac") ? "fac" : "police";
}

export function startFivemActionService(client: Client, context: BotContext) {
  if (!isFivemActionRuntimeEnabled()) return;
  if (serviceStarted) return;
  serviceStarted = true;
  void processPanelRequests(client, context);
  const interval = setInterval(() => void processPanelRequests(client, context), 15_000);
  interval.unref();
}

export async function handleFivemActionInteraction(interaction: Interaction, context: BotContext) {
  if (!(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  try {
    if (!isFivemActionRuntimeEnabled()) { await interaction.reply({ content: "Sistema de Ações não liberado para este bot.", ephemeral: true }); return true; }
    if (!interaction.guildId || !interaction.guild) { await interaction.reply({ content: "Use este sistema dentro de um servidor.", ephemeral: true }); return true; }
    const [, action, id, extra] = interaction.customId.split(":");
    if (interaction.isStringSelectMenu() && action === "open") await openAction(interaction, context);
    else if (interaction.isButton() && action === "type") await createActionFromType(interaction, context, id!, extra as FivemActionType);
    else if (interaction.isButton() && action === "join") await changeParticipant(interaction, context, id!, true);
    else if (interaction.isButton() && action === "leave") await changeParticipant(interaction, context, id!, false);
    else if (interaction.isButton() && action === "result") await chooseResult(interaction, context, id!);
    else if (interaction.isButton() && action === "cancel") await cancelAction(interaction, context, id!);
    else if (interaction.isButton() && action === "page") await showActionPage(interaction, context, id!);
    else if (interaction.isStringSelectMenu() && action === "finish") await finishAction(interaction, context, id!);
    else if (interaction.isModalSubmit() && action === "finish_modal") await submitResultModal(interaction, context, id!, extra as "victory" | "defeat");
    else await replyOrEdit(interaction, "Ação do painel inválida.");
  } catch (error) {
    await replyOrEdit(interaction, readApiError(error) ?? "Não foi possível concluir esta ação.");
  }
  return true;
}

async function processPanelRequests(client: Client, context: BotContext) {
  if (polling) return; polling = true;
  try {
    const configs = await context.api.getActiveFivemActionConfigs();
    for (const config of configs) {
      if (!config.lastPanelRequestedAt) continue;
      const key = `${config.guildId}:${config.architecture}`;
      if (handledRequests.get(key) === config.lastPanelRequestedAt) continue;
      await publishMainPanel(client, context, config);
      handledRequests.set(key, config.lastPanelRequestedAt);
    }
  } catch (error) { console.warn("[fivem-actions] falha ao processar painéis:", errorMessage(error)); }
  finally { polling = false; }
}

async function publishMainPanel(client: Client, context: BotContext, config: FivemActionSettings) {
  if (!firstId(config.panelChannelIds, config.panelChannelId)) throw new Error(`Canal principal não configurado para ${config.guildId}/${config.architecture}.`);
  const guild = await client.guilds.fetch(config.guildId);
  const channel = await firstTextChannel(guild, config.panelChannelIds, config.panelChannelId);
  if (!channel) throw new Error("Canal do painel inválido ou sem acesso.");
  const dashboard = await context.api.getFivemActionDashboard(config.guildId, config.architecture);
  const enabled = dashboard.actions.filter((item) => item.enabled).sort((a, b) => a.order - b.order);
  if (!enabled.length) throw new Error("Cadastre ao menos uma ação antes de publicar.");
  const selection = actionSelectionPayload(config, dashboard.actions);
  if (!selection) throw new Error("Cadastre ao menos uma ação antes de publicar.");
  const payload = { ...selection, flags: MessageFlags.IsComponentsV2 as const };
  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  if (message) await message.edit(payload); else message = await channel.send(payload);
  await context.api.updateFivemActionPanelState({ guildId: config.guildId, architecture: config.architecture, panelMessageId: message.id });
}

function actionSelectionPayload(config: FivemActionSettings, actions: Array<{ id: string; name: string; description: string; emoji: string | null; enabled: boolean; order: number }>) {
  const enabled = actions.filter((item) => item.enabled).sort((a, b) => a.order - b.order);
  if (!enabled.length) return null;
  const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}:open:${config.architecture}`).setPlaceholder("🎯 Escolha uma ação").addOptions(enabled.slice(0, 25).map((item) => ({ label: item.name.slice(0, 100), value: `${config.architecture}|${item.id}`, description: item.description.slice(0, 100) || undefined, emoji: item.emoji || undefined })));
  const intro = { type: 10, content: [`# ${config.panelTitle}`, config.panelDescription].join("\n") };
  const tutorial = { type: 10, content: ["## 📖 Como funciona", "1️⃣ Escolha uma ação no menu.", "2️⃣ Vá ao painel criado.", "3️⃣ Entre na ação e aguarde a equipe.", "4️⃣ O responsável encerra em Resultado da ação.", "5️⃣ O relatório será enviado automaticamente."].join("\n") };
  const fallbackImageUrl = config.imageUrl && config.imagePosition !== "none" ? resolvePanelImageUrl(config.imageUrl) : null;
  const media = fallbackImageUrl ? [mediaBlock(fallbackImageUrl, config.panelTitle)] : [];
  const contentComponents: any[] = config.imagePosition === "top" && media.length ? [...media, intro, tutorial] : config.imagePosition === "center" && media.length ? [intro, ...media, tutorial] : [intro, tutorial, ...media];
  const navigation = enabled.length > 25 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:page:${config.architecture}|1`).setLabel("Mais ações").setEmoji("➡️").setStyle(ButtonStyle.Secondary))] : [];
  return { components: [{ type: 17, accent_color: parseColor(config.color), components: [...contentComponents, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), ...navigation] }] };
}

async function openAction(interaction: StringSelectMenuInteraction, context: BotContext) {
  await interaction.deferReply({ ephemeral: true });
  const [architectureRaw, actionId] = (interaction.values[0] ?? "").split("|");
  const architecture = architectureRaw as FivemActionArchitecture;
  if (!actionId || !["fac", "police"].includes(architecture)) return void await interaction.editReply("Ação inválida.");
  if (!isFivemActionRuntimeEnabled(architecture)) return void await interaction.editReply(architecture === "police" ? "Acoes policiais nao liberadas para este bot." : "Acoes FAC nao liberadas para este bot.");
  const dashboard = await context.api.getFivemActionDashboard(interaction.guildId!, architecture);
  const action = dashboard.actions.find((item) => item.id === actionId);
  const member = interaction.member as GuildMember;
  if (!action) return void await interaction.editReply("Ação não encontrada.");
  if (action.authorizedRoleIds?.length && !action.authorizedRoleIds.some((roleId) => member.roles.cache.has(roleId))) {
    return void await interaction.editReply("Você não possui o cargo autorizado para esta ação.");
  }
  const allowedTypes = action.allowedTypes?.length ? action.allowedTypes : ["fuga", "tiro"];
  const buttons = new ActionRowBuilder<ButtonBuilder>();
  if (allowedTypes.includes("fuga")) buttons.addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:type:${architecture}|${actionId}:fuga`).setLabel("Fuga").setEmoji("🏃").setStyle(ButtonStyle.Secondary));
  if (allowedTypes.includes("tiro")) buttons.addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:type:${architecture}|${actionId}:tiro`).setLabel("Tiro").setEmoji("🔫").setStyle(ButtonStyle.Primary));
  await interaction.editReply({
    components: [{ type: 17, accent_color: parseColor(action.color), components: [{ type: 10, content: `## ${action.emoji ?? "🎯"} ${action.name}\nQual será o tipo da ação?` }, buttons] }],
    flags: MessageFlags.IsComponentsV2
  });
}

async function createActionFromType(interaction: any, context: BotContext, token: string, actionType: FivemActionType) {
  await interaction.deferReply({ ephemeral: true });
  const [architectureRaw, actionId] = token.split("|");
  const architecture = architectureRaw as FivemActionArchitecture;
  if (!actionId || !["fac", "police"].includes(architecture)) return void await interaction.editReply("Ação inválida.");
  if (!isFivemActionRuntimeEnabled(architecture)) return void await interaction.editReply(architecture === "police" ? "Ações policiais não liberadas para este bot." : "Ações FAC não liberadas para este bot.");
  const dashboard = await context.api.getFivemActionDashboard(interaction.guildId!, architecture);
  const action = dashboard.actions.find((item) => item.id === actionId);
  const member = interaction.member as GuildMember;
  if (!action) return void await interaction.editReply("Ação não encontrada.");
  if (!(action.allowedTypes?.length ? action.allowedTypes : ["fuga", "tiro"]).includes(actionType)) return void await interaction.editReply("Esse tipo não está liberado para esta ação.");
  const channelId = firstId(dashboard.settings.actionChannelIds, dashboard.settings.actionChannelId);
  if (!channelId) return void await interaction.editReply("Canal de ações não configurado.");
  const channel = await firstTextChannel(interaction.guild!, dashboard.settings.actionChannelIds, dashboard.settings.actionChannelId);
  if (!channel) return void await interaction.editReply("Canal de ações inválido ou sem acesso.");
  const session = await context.api.createFivemActionSession({ guildId: interaction.guildId!, architecture, actionId, actionType, openerId: interaction.user.id, openerName: displayName(interaction.member), openerRoleIds: [...member.roles.cache.keys()] });
  const message = await channel.send(sessionPayload(session));
  await context.api.updateFivemActionSessionMessage(session.id, { channelId: channel.id, messageId: message.id });
  await sendActionLog(interaction, context, dashboard.settings, `📋 LOG DO SISTEMA DE AÇÃO\n\nEvento: Ação criada\nAção: ${session.actionName}\nTipo: ${typeLabel(session.actionType)}\nResponsável: <@${session.openerId}>\nExecutado por: <@${interaction.user.id}>\nData: ${formatDate(new Date().toISOString())}`);
  await interaction.editReply(`Painel de **${session.actionName}** criado em <#${channel.id}>.${action.destinationSystem ? `\nDestino configurado: **${action.destinationSystem}**.` : ""}`);
}

async function showActionPage(interaction: any, context: BotContext, token: string) {
  const [architectureRaw, pageRaw] = token.split("|");
  const architecture = architectureRaw as FivemActionArchitecture;
  if (!isFivemActionRuntimeEnabled(architecture)) return void await interaction.reply({ content: architecture === "police" ? "Acoes policiais nao liberadas para este bot." : "Acoes FAC nao liberadas para este bot.", ephemeral: true });
  const page = Math.max(0, Number.parseInt(pageRaw ?? "0", 10) || 0);
  const dashboard = await context.api.getFivemActionDashboard(interaction.guildId, architecture);
  const actions = dashboard.actions.filter((item) => item.enabled).sort((a, b) => a.order - b.order);
  const pages = Math.max(1, Math.ceil(actions.length / 25));
  const safePage = Math.min(page, pages - 1);
  const items = actions.slice(safePage * 25, safePage * 25 + 25);
  const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}:open:${architecture}`).setPlaceholder(`Ações ${safePage + 1}/${pages}`).addOptions(items.map((item) => ({ label: item.name.slice(0, 100), value: `${architecture}|${item.id}`, description: item.description.slice(0, 100) || undefined, emoji: item.emoji || undefined })));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:page:${architecture}|${safePage - 1}`).setLabel("Anterior").setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`${PREFIX}:page:${architecture}|${safePage + 1}`).setLabel("Próxima").setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pages - 1)
  );
  const payload = { components: [{ type: 17, accent_color: parseColor(dashboard.settings.color), components: [{ type: 10, content: `## Escolha uma ação\nPágina ${safePage + 1} de ${pages}` }, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), buttons] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 };
  if (interaction.replied || interaction.deferred) await interaction.editReply(payload); else await interaction.reply(payload);
}

async function changeParticipant(interaction: any, context: BotContext, sessionId: string, joining: boolean) {
  await interaction.deferReply({ ephemeral: true });
  const member = interaction.member as GuildMember;
  const session = joining
    ? await context.api.joinFivemActionSession(sessionId, { userId: interaction.user.id, username: displayName(member), roleIds: [...member.roles.cache.keys()] })
    : await context.api.leaveFivemActionSession(sessionId, interaction.user.id);
  await refreshSessionMessage(interaction, session);
  await interaction.editReply(joining ? "Você entrou na ação." : "Você saiu da ação.");
}

async function chooseResult(interaction: any, context: BotContext, sessionId: string) {
  const session = await context.api.getFivemActionSession(sessionId);
  if (!session) { await interaction.reply({ content: "Ação não encontrada.", ephemeral: true }); return; }
  if (session.status !== "active") { await interaction.reply({ content: "Esta ação já foi encerrada.", ephemeral: true }); return; }
  const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}:finish:${sessionId}`).setPlaceholder("Selecione o resultado").addOptions({ label: "Vitória", value: "victory", emoji: "🏆" }, { label: "Derrota", value: "defeat", emoji: "❌" });
  await interaction.reply({ components: [{ type: 17, accent_color: 0x7c3aed, components: [{ type: 10, content: `## 📊 Resultado da ação\n**Ação:** ${session.actionName}\n**Tipo:** ${typeLabel(session.actionType)}\n\nSelecione abaixo o resultado dessa ação.` }, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

async function finishAction(interaction: StringSelectMenuInteraction, context: BotContext, sessionId: string) {
  const result = interaction.values[0] as "victory" | "defeat";
  const modal = new ModalBuilder().setCustomId(`${PREFIX}:finish_modal:${sessionId}:${result}`).setTitle(result === "victory" ? "Resultado: Vitória" : "Resultado: Derrota");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("observation").setLabel("Observação da ação").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("finalParticipantCount").setLabel("Quantidade de participantes final").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("extraInfo").setLabel("Informações extras").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000))
  );
  await interaction.showModal(modal);
}

async function submitResultModal(interaction: any, context: BotContext, sessionId: string, result: "victory" | "defeat") {
  await interaction.deferReply({ ephemeral: true });
  const member = interaction.member as GuildMember;
  const finalParticipantCountRaw = interaction.fields.getTextInputValue("finalParticipantCount")?.trim();
  const finalParticipantCount = finalParticipantCountRaw ? Number.parseInt(finalParticipantCountRaw, 10) : null;
  const actorIsAdmin = interaction.guild?.ownerId === interaction.user.id || member.permissions.has(PermissionFlagsBits.Administrator);
  const session = await context.api.finishFivemActionSession(sessionId, {
    actorId: interaction.user.id,
    actorRoleIds: [...member.roles.cache.keys()],
    actorIsAdmin,
    result,
    observation: interaction.fields.getTextInputValue("observation") || null,
    extraInfo: interaction.fields.getTextInputValue("extraInfo") || null,
    finalParticipantCount: Number.isFinite(finalParticipantCount) ? finalParticipantCount : null
  });
  await refreshSessionMessage(interaction, session);
  await sendReport(interaction, context, session);
  await interaction.editReply("✅ Resultado registrado com sucesso.");
}

async function cancelAction(interaction: any, context: BotContext, sessionId: string) {
  await interaction.deferReply({ ephemeral: true });
  const member = interaction.member as GuildMember;
  const actorIsAdmin = interaction.guild?.ownerId === interaction.user.id || member.permissions.has(PermissionFlagsBits.Administrator);
  const session = await context.api.cancelFivemActionSession(sessionId, { actorId: interaction.user.id, actorRoleIds: [...member.roles.cache.keys()], actorIsAdmin, reason: "Cancelada pelo painel da ação." });
  await refreshSessionMessage(interaction, session);
  await interaction.editReply("Ação cancelada.");
}

async function refreshSessionMessage(interaction: any, session: FivemActionSession) {
  if (!session.channelId || !session.messageId) return;
  const channel = await interaction.guild.channels.fetch(session.channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  const message = await channel.messages.fetch(session.messageId).catch(() => null);
  if (message) await message.edit(sessionPayload(session));
}

async function sendReport(interaction: any, context: BotContext, session: FivemActionSession) {
  const dashboard = await context.api.getFivemActionDashboard(session.guildId, session.architecture);
  const categoryId = firstId(dashboard.settings.categoryIds, dashboard.settings.categoryId);
  let channel = await firstTextChannel(interaction.guild!, dashboard.settings.reportChannelIds, dashboard.settings.reportChannelId);
  if (!channel) channel = await interaction.guild!.channels.create({ name: "relatorio-de-acoes", type: ChannelType.GuildText, parent: categoryId ?? undefined, reason: "Relatorios do Sistema de Acoes" });
  if (!channel) return;
  if (!channel.isTextBased() || channel.isDMBased()) return;
  const active = session.participants.filter((item) => !item.leftAt);
  const duration = Math.max(0, Math.round(((session.finishedAt ? Date.parse(session.finishedAt) : Date.now()) - Date.parse(session.startedAt)) / 60000));
  const total = session.finalParticipantCount ?? active.length;
  const members = active.length ? active.map((item) => `• <@${item.userId}>`).join("\n") : "Nenhum participante.";
  await channel.send({ components: [{ type: 17, accent_color: session.status === "victory" ? 0x22c55e : 0xef4444, components: [{ type: 10, content: `# 📊 RESULTADO DA AÇÃO\n\n**🎯 Ação**\n${session.actionName}\n\n**⚔️ Tipo**\n${typeLabel(session.actionType)}\n\n**${session.status === "victory" ? "🏆" : "❌"} Resultado**\n${session.status === "victory" ? "Vitória" : "Derrota"}\n\n**👮 Responsável**\n<@${session.openerId}>\n\n**👥 Participantes**\n${members}\n\n**📈 Total de participantes**\n${total}/${session.maxParticipants}\n\n**🕒 Iniciada em**\n${formatDate(session.startedAt)}\n\n**✅ Finalizada em**\n${formatDate(session.finishedAt ?? new Date().toISOString())}\n\n**⏱️ Duração**\n${duration} minutos\n\n**📝 Observação**\n${session.observation || "Sem observação."}${session.extraInfo ? `\n\n**📌 Informações extras**\n${session.extraInfo}` : ""}` }] }], flags: MessageFlags.IsComponentsV2 });
  await sendActionLog(interaction, context, dashboard.settings, `📋 LOG DO SISTEMA DE AÇÃO\n\nEvento: Resultado registrado\nAção: ${session.actionName}\nTipo: ${typeLabel(session.actionType)}\nResultado: ${session.status === "victory" ? "Vitória" : "Derrota"}\nResponsável: <@${session.openerId}>\nExecutado por: <@${interaction.user.id}>\nData: ${formatDate(new Date().toISOString())}`);
}

function sessionPayload(session: FivemActionSession) {
  const active = session.participants.filter((item) => !item.leftAt);
  const full = active.length >= session.maxParticipants;
  const status = session.status === "active" ? "🟡 Em andamento" : session.status === "victory" ? "🟢 Finalizada" : session.status === "defeat" ? "🔴 Finalizada" : "⚫ Cancelada";
  const result = session.status === "victory" ? "Vitória" : session.status === "defeat" ? "Derrota" : session.status === "cancelled" ? "Cancelada" : "Aguardando";
  const rows = session.status === "active" ? [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:join:${session.id}`).setLabel("Entrar").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(full),
      new ButtonBuilder().setCustomId(`${PREFIX}:leave:${session.id}`).setLabel("Sair").setEmoji("🚪").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:result:${session.id}`).setLabel("Resultado da ação").setEmoji("📊").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}:cancel:${session.id}`).setLabel("Cancelar").setEmoji("🛑").setStyle(ButtonStyle.Danger)
    )
  ] : [];
  const details = { type: 10, content: `# ${session.actionEmoji ?? "🎯"} ${session.actionName.toUpperCase()}\nSistema de Ações - NPD\n\n**📌 Status**\n${status}\n\n**⚔️ Tipo da ação**\n${typeLabel(session.actionType)}\n\n**👥 Participantes**\n${active.length}/${session.maxParticipants}\n\n**👮 Responsável**\n<@${session.openerId}>\n\n**🕒 Iniciada em**\n${formatDate(session.startedAt)}\n\n**📊 Resultado**\n${result}\n\n**📋 Situação**\n${active.map((item) => `• <@${item.userId}>`).join("\n") || "Aguardando participantes."}\n\nID: \`${session.id.slice(0, 8)}\`` };
  const image = session.actionImageUrl ? [{ type: 12, items: [{ media: { url: session.actionImageUrl } }] }] : [];
  return { components: [{ type: 17, accent_color: session.status === "active" ? parseColor(session.actionColor) : session.status === "victory" ? 0x22c55e : 0xef4444, components: [details, ...image, ...rows] }], flags: MessageFlags.IsComponentsV2 as const };
}

async function getPanelVisualSlots(context: BotContext, guildId: string, basePanelId: string) {
  const panelIds = [basePanelId, `${basePanelId}-banner-2`, `${basePanelId}-banner-3`];
  const visuals = await Promise.all(panelIds.map((panelId) => context.api.getPanelVisualSettings(guildId, panelId).catch(() => null)));

  return visuals.flatMap((visual, index): PanelVisualConfig[] => {
    if (!visual?.imageEnabled || !visual.imageUrl) return [];
    if (index > 0 && visual.useGlobalDefault) return [];
    return [{ imageEnabled: visual.imageEnabled, imagePosition: visual.imagePosition, imageUrl: resolvePanelImageUrl(visual.imageUrl) ?? visual.imageUrl }];
  });
}

function actionImagePosition(position: PanelVisualConfig["imagePosition"]): FivemActionSettings["imagePosition"] {
  if (position === "top" || position === "banner") return "top";
  if (position === "middle" || position === "below_title" || position === "below_text" || position === "before_buttons" || position === "above_buttons") return "center";
  if (position === "none") return "none";
  return "bottom";
}

function mediaBlock(url: string, description: string) {
  return { type: 12, items: [{ media: { url }, description }] };
}

async function sendActionLog(interaction: any, _context: BotContext, settings: FivemActionSettings, content: string) {
  const channel = await firstTextChannel(interaction.guild!, settings.logChannelIds, settings.logChannelId);
  if (!channel) return;
  await channel.send({ components: [{ type: 17, accent_color: parseColor(settings.color), components: [{ type: 10, content }] }], flags: MessageFlags.IsComponentsV2 }).catch(() => undefined);
}

function typeLabel(type: FivemActionType) {
  return type === "fuga" ? "🏃 Fuga" : "🔫 Tiro";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(value));
}

function isFivemActionRuntimeEnabled(architecture?: FivemActionArchitecture) {
  if (architecture) return isBotModuleEnabled(MODULE_BY_ARCHITECTURE[architecture]);
  return isBotModuleEnabled(MODULE_BY_ARCHITECTURE.fac) || isBotModuleEnabled(MODULE_BY_ARCHITECTURE.police);
}

function parseColor(value: string) { return Number.parseInt(value.replace("#", ""), 16) || 0x7c3aed; }
function displayName(member: any) { return member?.displayName ?? member?.user?.globalName ?? member?.user?.username ?? "Usuário"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function firstId(values: string[] | undefined, fallback: string | null | undefined) { return values?.[0] ?? fallback ?? null; }
async function firstTextChannel(guild: NonNullable<Interaction["guild"]>, ids: string[] | undefined, fallback: string | null | undefined) {
  const channelIds = [...new Set([...(ids ?? []), fallback].filter((id): id is string => Boolean(id)))];
  for (const channelId of channelIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && !channel.isDMBased() && "send" in channel) return channel;
  }
  return null;
}
async function replyOrEdit(interaction: Interaction, content: string) {
  if (!interaction.isRepliable()) return;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components: [] }).catch(() => interaction.followUp({ content, ephemeral: true }).catch(() => null));
    return;
  }
  await interaction.reply({ content, ephemeral: true }).catch(() => null);
}
function readApiError(error: unknown) {
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    if (typeof response?.data?.message === "string") return response.data.message;
  }
  return error instanceof Error ? error.message : null;
}
