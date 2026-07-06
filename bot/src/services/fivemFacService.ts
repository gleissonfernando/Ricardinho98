import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction
} from "discord.js";
import { env, isBotModuleEnabled } from "../config/env";
import type { BotContext } from "../types";
import type { FivemFacAbsence, FivemFacSettings } from "./apiClient";
import { assertPanelChannelPermissions, pinPanelMessage } from "./panelDeliveryService";

const FAC_PREFIX = "fivem_fac";
const REQUEST_BUTTON_ID = `${FAC_PREFIX}:request`;
const MINE_BUTTON_ID = `${FAC_PREFIX}:mine`;
const REQUEST_MODAL_PREFIX = `${FAC_PREFIX}:request_modal`;
const CONFIRM_PREFIX = `${FAC_PREFIX}:confirm`;
const CANCEL_PREFIX = `${FAC_PREFIX}:cancel`;
const REJECT_MODAL_PREFIX = `${FAC_PREFIX}:reject_modal`;
const APPROVE_PREFIX = `${FAC_PREFIX}:approve`;
const REJECT_PREFIX = `${FAC_PREFIX}:reject`;
const CLOSE_PREFIX = `${FAC_PREFIX}:close`;
const FAC_CHECK_INTERVAL_MS = 5_000;
const FAC_PANEL_REQUEST_CHECK_INTERVAL_MS = 5_000;
const PENDING_REQUEST_TTL_MS = 10 * 60_000;

type PendingAbsenceRequest = {
  createdAt: number;
  endDate: string;
  guildId: string;
  reason: string;
  startDate: string;
  userId: string;
  username: string | null;
};

type RoleChangeResult = {
  ok: boolean;
  reason?: string;
};

let dueCheckRunning = false;
let panelRequestCheckRunning = false;
let serviceStarted = false;
const handledPanelRequests = new Map<string, string>();
const panelPublishPromises = new Map<string, Promise<FivemFacSettings>>();
const panelRequestErrorLogAt = new Map<string, number>();
const pendingAbsenceRequests = new Map<string, PendingAbsenceRequest>();

export function startFivemFacService(client: Client, context: BotContext) {
  if (!isBotModuleEnabled("fivem-fac")) {
    return;
  }

  if (serviceStarted) {
    return;
  }

  serviceStarted = true;

  context.socket.onFivemFacSettingsUpdated((payload) => {
    if (!isPayloadForThisBot(payload.botId)) {
      return;
    }

    console.log(`[fivem-fac] configuracao atualizada em tempo real para ${payload.guildId}.`);
  });

  context.socket.onFivemFacPanelPublish((payload) => {
    if (!isPayloadForThisBot(payload.botId)) {
      return;
    }

    void publishRequestedFivemFacPanel(client, context, payload.guildId).catch((error) => {
      console.error(`[fivem-fac] falha ao publicar painel em ${payload.guildId}:`, errorMessage(error));
    });
  });

  context.socket.onFivemFacAbsenceUpdated((payload) => {
    const absence = payload.absence;

    if (!isPayloadForThisBot(payload.botId) || !isFivemFacAbsencePayload(absence)) {
      return;
    }

    void updateFivemFacAbsenceMessage(client, absence).catch((error) => {
      console.warn(`[fivem-fac] falha ao atualizar mensagem da ausencia ${absence.id}:`, errorMessage(error));
    });
  });

  void context.api.getActiveFivemFacConfigs()
    .then((configs) => console.log(`[fivem-fac] ${configs.length} configuracao(oes) ativa(s) carregada(s).`))
    .catch((error) => console.warn("[fivem-fac] nao foi possivel carregar configuracoes:", errorMessage(error)));

  void processDueFivemFacAbsences(client, context);
  void processPendingFivemFacPanelRequests(client, context);

  const interval = setInterval(() => {
    void processDueFivemFacAbsences(client, context);
  }, FAC_CHECK_INTERVAL_MS);
  const panelInterval = setInterval(() => {
    void processPendingFivemFacPanelRequests(client, context);
  }, FAC_PANEL_REQUEST_CHECK_INTERVAL_MS);

  interval.unref();
  panelInterval.unref();
}

export async function handleFivemFacInteraction(interaction: Interaction, context: BotContext) {
  if (!interaction.isButton() && !interaction.isModalSubmit()) {
    return false;
  }

  const customId = interaction.customId;

  if (!customId.startsWith(`${FAC_PREFIX}:`)) {
    return false;
  }

  if (!isBotModuleEnabled("fivem-fac")) {
    await replySafely(interaction, "O sistema FAC nao foi liberado para este bot na dashboard.");
    return true;
  }

  if (!interaction.guild) {
    await replySafely(interaction, "Este recurso esta disponivel apenas em servidores.");
    return true;
  }

  if (interaction.isButton()) {
    await handleFivemFacButton(interaction, context);
    return true;
  }

  await handleFivemFacModal(interaction, context);
  return true;
}

async function handleFivemFacButton(interaction: ButtonInteraction, context: BotContext) {
  if (interaction.customId === REQUEST_BUTTON_ID) {
    await showRequestModal(interaction);
    return;
  }

  if (interaction.customId === MINE_BUTTON_ID) {
    await showMyAbsences(interaction, context);
    return;
  }

  const [prefix, action, value] = interaction.customId.split(":");

  if (prefix !== FAC_PREFIX || !value) {
    await interaction.reply({
      content: "Acao do FAC invalida.",
      ephemeral: true
    });
    return;
  }

  if (action === "confirm") {
    await confirmAbsenceRequest(interaction, context, value);
    return;
  }

  if (action === "cancel") {
    await cancelAbsenceRequest(interaction, value);
    return;
  }

  if (action === "approve") {
    await approveAbsence(interaction, context, value);
    return;
  }

  if (action === "reject") {
    await showRejectModal(interaction, value);
    return;
  }

  if (action === "close") {
    await closeAbsence(interaction, context, value);
    return;
  }

  await interaction.reply({
    content: "Acao do FAC nao reconhecida.",
    ephemeral: true
  });
}

async function handleFivemFacModal(interaction: ModalSubmitInteraction, context: BotContext) {
  if (interaction.customId.startsWith(`${REQUEST_MODAL_PREFIX}:`)) {
    await submitAbsenceRequest(interaction, context);
    return;
  }

  if (interaction.customId.startsWith(`${REJECT_MODAL_PREFIX}:`)) {
    const absenceId = interaction.customId.slice(`${REJECT_MODAL_PREFIX}:`.length);
    await rejectAbsence(interaction, context, absenceId);
    return;
  }

  await interaction.reply({
    content: "Formulario do FAC nao reconhecido.",
    ephemeral: true
  });
}

async function showRequestModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId(`${REQUEST_MODAL_PREFIX}:${interaction.guildId}`)
    .setTitle("📅 Solicitar Ausência");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("startDate")
        .setLabel("📅 Data de início")
        .setMaxLength(10)
        .setPlaceholder("Exemplo: 12/06 ou 12/06/2026")
        .setRequired(false)
        .setStyle(TextInputStyle.Short)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("returnDate")
        .setLabel("📅 Data de Retorno")
        .setMaxLength(10)
        .setPlaceholder("Exemplo: 12/07 ou 12/07/2026")
        .setRequired(true)
        .setStyle(TextInputStyle.Short)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("📝 Motivo da Ausência")
        .setMaxLength(300)
        .setPlaceholder("Exemplo: Viagem, trabalho, estudos, problemas pessoais, etc.")
        .setRequired(true)
        .setStyle(TextInputStyle.Short)
    )
  );

  await interaction.showModal(modal);
}

async function showRejectModal(interaction: ButtonInteraction, absenceId: string) {
  const modal = new ModalBuilder()
    .setCustomId(`${REJECT_MODAL_PREFIX}:${absenceId}`)
    .setTitle("Reprovar Ausencia");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Motivo da reprovacao")
        .setMaxLength(800)
        .setRequired(true)
        .setStyle(TextInputStyle.Paragraph)
    )
  );

  await interaction.showModal(modal);
}

async function submitAbsenceRequest(interaction: ModalSubmitInteraction, context: BotContext) {
  await interaction.deferReply({
    ephemeral: true
  });

  const guild = interaction.guild;

  if (!guild) {
    await interaction.editReply("Servidor nao encontrado.");
    return;
  }

  const today = currentDateKey();
  const startDateInput = interaction.fields.getTextInputValue("startDate").trim();
  const startDate = startDateInput ? normalizeBrazilianDateInput(startDateInput, today) : today;
  const endDate = startDate ? normalizeBrazilianDateInput(interaction.fields.getTextInputValue("returnDate"), startDate) : null;
  const reason = interaction.fields.getTextInputValue("reason").trim();

  if (!startDate) {
    await interaction.editReply("Use a data de inicio no formato DD/MM ou DD/MM/AAAA. Exemplo: 12/06.");
    return;
  }

  if (!endDate) {
    await interaction.editReply("Use a data de retorno no formato DD/MM ou DD/MM/AAAA. Exemplo: 12/07.");
    return;
  }

  if (endDate < startDate) {
    await interaction.editReply("A data de retorno nao pode ser menor que a data de inicio.");
    return;
  }

  if (!reason) {
    await interaction.editReply("Informe o motivo da ausencia.");
    return;
  }

  try {
    const settings = await context.api.getFivemFacSettings(guild.id);

    if (!hasMemberRole(interaction, settings)) {
      await interaction.editReply("Voce nao possui um cargo de membro autorizado para solicitar ausencia.");
      return;
    }

    const token = createPendingAbsenceRequest({
      createdAt: Date.now(),
      endDate,
      guildId: guild.id,
      reason,
      startDate,
      userId: interaction.user.id,
      username: interaction.member instanceof Object && "displayName" in interaction.member
        ? interaction.member.displayName
        : interaction.user.username
    });

    await interaction.editReply(buildRequestSummaryPayload(token, {
      endDate,
      reason,
      startDate
    }));
  } catch (error) {
    await interaction.editReply(readRequestErrorMessage(error) ?? "Nao foi possivel preparar sua solicitacao de ausencia.");
  }
}

async function confirmAbsenceRequest(interaction: ButtonInteraction, context: BotContext, token: string) {
  await interaction.deferUpdate();
  cleanupPendingAbsenceRequests();

  const pending = pendingAbsenceRequests.get(token);

  if (!pending || pending.userId !== interaction.user.id || pending.guildId !== interaction.guildId) {
    await interaction.editReply({
      components: [],
      content: "Esta solicitacao expirou. Abra o formulario novamente.",
      embeds: []
    });
    return;
  }

  pendingAbsenceRequests.delete(token);

  const guild = interaction.guild;

  if (!guild) {
    await interaction.editReply({
      components: [],
      content: "Servidor nao encontrado.",
      embeds: []
    });
    return;
  }

  try {
    const settings = await context.api.getFivemFacSettings(guild.id);

    if (!hasMemberRole(interaction, settings)) {
      await interaction.editReply({
        components: [],
        content: "Voce nao possui um cargo de membro autorizado para solicitar ausencia.",
        embeds: []
      });
      return;
    }

    const absence = await context.api.createFivemFacAbsence({
      guildId: guild.id,
      notes: null,
      reason: pending.reason,
      startDate: pending.startDate,
      endDate: pending.endDate,
      userId: pending.userId,
      username: pending.username
    });
    const channelResult = await sendAbsenceRequestPanel(guild, settings, absence);

    if (channelResult.channel && channelResult.messageId) {
      await context.api.updateFivemFacAbsenceChannel(absence.id, {
        privateChannelId: channelResult.channel.id,
        requestMessageId: channelResult.messageId
      });
    }

    await sendFacLog(guild, settings, "Solicitacao criada", absence, interaction.user.id);
    await interaction.editReply({
      components: [],
      content: channelResult.channel
        ? `${settings.messages.requestCreated}\nCanal de analise: <#${channelResult.channel.id}>`
        : `${settings.messages.requestCreated}\nA solicitacao foi salva, mas nao consegui enviar o painel para o canal configurado. Avise a equipe.`,
      embeds: []
    });
  } catch (error) {
    await interaction.editReply({
      components: [],
      content: readRequestErrorMessage(error) ?? "Nao foi possivel criar sua solicitacao de ausencia.",
      embeds: []
    });
  }
}

async function cancelAbsenceRequest(interaction: ButtonInteraction, token: string) {
  await interaction.deferUpdate();
  pendingAbsenceRequests.delete(token);
  await interaction.editReply({
    components: [],
    content: "Solicitacao cancelada.",
    embeds: []
  });
}

async function showMyAbsences(interaction: ButtonInteraction, context: BotContext) {
  await interaction.deferReply({
    ephemeral: true
  });

  const guild = interaction.guild;

  if (!guild) {
    await interaction.editReply("Servidor nao encontrado.");
    return;
  }

  try {
    const absences = await context.api.getFivemFacUserAbsences(guild.id, interaction.user.id);

    if (!absences.length) {
      await interaction.editReply("Voce ainda nao possui ausencias registradas.");
      return;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("Minhas ausencias")
          .setDescription(absences.map(formatAbsenceLine).join("\n"))
      ]
    });
  } catch (error) {
    await interaction.editReply(readRequestErrorMessage(error) ?? "Nao foi possivel buscar suas ausencias.");
  }
}

async function approveAbsence(interaction: ButtonInteraction, context: BotContext, absenceId: string) {
  await interaction.deferReply({
    ephemeral: true
  });

  const guild = interaction.guild;

  if (!guild) {
    await interaction.editReply("Servidor nao encontrado.");
    return;
  }

  try {
    const settings = await context.api.getFivemFacSettings(guild.id);

    if (!hasApproverRole(interaction, settings)) {
      await interaction.editReply("Voce nao possui cargo autorizado para aprovar ausencias.");
      return;
    }

    let absence = await context.api.approveFivemFacAbsence(absenceId, {
      moderatorId: interaction.user.id,
      moderatorRoleIds: interactionRoleIds(interaction)
    });

    const roleResult = await addAbsenceRole(guild, settings, absence);
    absence = await context.api.markFivemFacAbsenceStarted(absence.id, roleResult.ok);
    await sendFacLog(guild, settings, roleResult.ok ? "Cargo adicionado" : "Falha ao adicionar cargo", absence, interaction.user.id, roleResult.reason);
    await sendFacLog(guild, settings, roleResult.ok ? "Ausencia aprovada com cargo" : "Ausencia aprovada sem cargo", absence, interaction.user.id, roleResult.reason);

    await updateAbsenceMessage(interaction, settings, absence);
    await sendFacLog(guild, settings, "Solicitacao aprovada", absence, interaction.user.id);
    const dmSent = await notifyApprovalUser(guild, settings, absence, interaction.user.id, roleResult);
    if (!dmSent) {
      await sendFacLog(guild, settings, "Erro ao enviar DM", absence, interaction.user.id, "DM fechada ou indisponivel.");
    }
    await interaction.editReply("Ausencia aprovada.");
  } catch (error) {
    await interaction.editReply(readRequestErrorMessage(error) ?? "Nao foi possivel aprovar essa ausencia.");
  }
}

async function rejectAbsence(interaction: ModalSubmitInteraction, context: BotContext, absenceId: string) {
  await interaction.deferReply({
    ephemeral: true
  });

  const guild = interaction.guild;

  if (!guild) {
    await interaction.editReply("Servidor nao encontrado.");
    return;
  }

  try {
    const settings = await context.api.getFivemFacSettings(guild.id);

    if (!hasApproverRole(interaction, settings)) {
      await interaction.editReply("Voce nao possui cargo autorizado para reprovar ausencias.");
      return;
    }

    const reason = interaction.fields.getTextInputValue("reason");
    const absence = await context.api.rejectFivemFacAbsence(absenceId, {
      moderatorId: interaction.user.id,
      moderatorRoleIds: interactionRoleIds(interaction),
      reason
    });

    await updateAbsenceMessage(interaction, settings, absence);
    await sendFacLog(guild, settings, "Solicitacao reprovada", absence, interaction.user.id, reason);
    const dmSent = await notifyRejectionUser(guild, absence, interaction.user.id, reason);
    if (!dmSent) {
      await sendFacLog(guild, settings, "Erro ao enviar DM", absence, interaction.user.id, "DM fechada ou indisponivel.");
    }
    await interaction.editReply("Ausencia reprovada.");
  } catch (error) {
    await interaction.editReply(readRequestErrorMessage(error) ?? "Nao foi possivel reprovar essa ausencia.");
  }
}

async function closeAbsence(interaction: ButtonInteraction, context: BotContext, absenceId: string) {
  await interaction.deferReply({
    ephemeral: true
  });

  const guild = interaction.guild;

  if (!guild) {
    await interaction.editReply("Servidor nao encontrado.");
    return;
  }

  try {
    const settings = await context.api.getFivemFacSettings(guild.id);

    if (!hasApproverRole(interaction, settings)) {
      await interaction.editReply("Voce nao possui cargo autorizado para encerrar ausencias.");
      return;
    }

    const current = await context.api.getFivemFacAbsence(absenceId);
    const roleResult = await removeAbsenceRole(guild, settings, current);
    const absence = await context.api.closeFivemFacAbsence(absenceId, {
      moderatorId: interaction.user.id,
      moderatorRoleIds: interactionRoleIds(interaction),
      roleRemoved: roleResult.ok
    });

    await updateAbsenceMessage(interaction, settings, absence);
    await sendFacLog(guild, settings, roleResult.ok ? "Cargo removido" : "Ausencia encerrada sem remover cargo", absence, interaction.user.id, roleResult.reason);
    const dmSent = await notifyAbsenceUser(guild, absence, "Sua ausencia foi encerrada pela equipe.");
    if (!dmSent) {
      await sendFacLog(guild, settings, "Erro ao enviar DM", absence, interaction.user.id, "DM fechada ou indisponivel.");
    }
    await interaction.editReply("Ausencia encerrada.");
  } catch (error) {
    await interaction.editReply(readRequestErrorMessage(error) ?? "Nao foi possivel encerrar essa ausencia.");
  }
}

async function publishRequestedFivemFacPanel(client: Client, context: BotContext, guildId: string) {
  const key = panelRequestKey(guildId);
  const current = panelPublishPromises.get(key);

  if (current) {
    return current;
  }

  const next = publishFivemFacPanel(client, context, guildId)
    .then((settings) => {
      rememberHandledPanelRequest(settings);
      return settings;
    })
    .finally(() => {
      panelPublishPromises.delete(key);
    });

  panelPublishPromises.set(key, next);
  return next;
}

async function publishFivemFacPanel(client: Client, context: BotContext, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  const settings = await context.api.getFivemFacSettings(guildId);

  if (!settings.enabled || !settings.panelChannelId) {
    throw new Error("FAC nao esta ativo ou sem canal de painel.");
  }

  const channel = await guild.channels.fetch(settings.panelChannelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error("Canal de painel FAC invalido.");
  }

  assertPanelChannelPermissions(channel, client, "FAC");

  const payload = buildPanelPayload(settings);
  let messageId: string | null = null;

  if (settings.panelMessageId) {
    const oldMessage = await channel.messages.fetch(settings.panelMessageId).catch(() => null);

    if (oldMessage) {
      if (oldMessage.flags.has(MessageFlags.IsComponentsV2)) {
        await oldMessage.delete().catch(() => null);
      } else {
        const edited = await oldMessage.edit(payload);
        await pinPanelMessage(edited, "FAC");
        messageId = edited.id;
      }
    }
  }

  if (!messageId) {
    const message = await channel.send(payload);
    await pinPanelMessage(message, "FAC");
    messageId = message.id;
  }

  const saved = await context.api.updateFivemFacPanelState({
    guildId,
    messageId
  });
  console.log(`[fivem-fac] painel publicado em ${guild.name}.`);
  return saved;
}

async function sendAbsenceRequestPanel(guild: Guild, settings: FivemFacSettings, absence: FivemFacAbsence) {
  const channel = settings.panelChannelId
    ? await guild.channels.fetch(settings.panelChannelId).catch(() => null)
    : null;

  if (!channel?.isTextBased()) {
    return { channel: null, messageId: null };
  }

  const message = await channel.send(buildAbsenceMessagePayload(absence));

  return {
    channel,
    messageId: message.id
  };
}

async function processDueFivemFacAbsences(client: Client, context: BotContext) {
  if (dueCheckRunning || !isBotModuleEnabled("fivem-fac")) {
    return;
  }

  dueCheckRunning = true;

  try {
    const today = currentDateKey();
    const absences = await context.api.getFivemFacDueAbsences(today);

    for (const absence of absences) {
      await processDueAbsence(client, context, absence, today).catch((error) => {
        console.warn(`[fivem-fac] falha ao processar ausencia ${absence.id}:`, errorMessage(error));
      });
    }
  } catch (error) {
    console.warn("[fivem-fac] falha no monitor de datas:", errorMessage(error));
  } finally {
    dueCheckRunning = false;
  }
}

async function processPendingFivemFacPanelRequests(client: Client, context: BotContext) {
  if (panelRequestCheckRunning || !isBotModuleEnabled("fivem-fac")) {
    return;
  }

  panelRequestCheckRunning = true;

  try {
    const configs = await context.api.getActiveFivemFacConfigs();

    for (const settings of configs) {
      if (!settings.lastPanelRequestedAt) {
        continue;
      }

      const key = panelRequestKey(settings.guildId);

      if (handledPanelRequests.get(key) === settings.lastPanelRequestedAt) {
        continue;
      }

      await publishRequestedFivemFacPanel(client, context, settings.guildId).catch((error) => {
        logPanelRequestError(key, `[fivem-fac] falha ao publicar painel pendente em ${settings.guildId}:`, error);
      });
    }
  } catch (error) {
    console.warn("[fivem-fac] falha ao verificar pedidos pendentes de painel:", errorMessage(error));
  } finally {
    panelRequestCheckRunning = false;
  }
}

async function processDueAbsence(client: Client, context: BotContext, absence: FivemFacAbsence, today: string) {
  const guild = await client.guilds.fetch(absence.guildId);
  const settings = await context.api.getFivemFacSettings(absence.guildId);
  let current = absence;

  if (current.status === "approved" && current.startDate <= today) {
    const roleResult = await addAbsenceRole(guild, settings, current);
    current = await context.api.markFivemFacAbsenceStarted(current.id, roleResult.ok);
    await sendFacLog(guild, settings, roleResult.ok ? "Cargo adicionado" : "Falha ao adicionar cargo", current, null, roleResult.reason);
    await sendFacLog(guild, settings, roleResult.ok ? "Ausencia iniciada com cargo" : "Ausencia iniciada sem cargo", current, null, roleResult.reason);
    await sendFacLog(guild, settings, "Ausencia iniciada", current, null);
    const dmSent = await notifyAbsenceUser(guild, current, settings.messages.started);
    if (!dmSent) {
      await sendFacLog(guild, settings, "Erro ao enviar DM", current, null, "DM fechada ou indisponivel.");
    }
    await updateStoredAbsenceMessage(guild, current);
  }

  if ((current.status === "active" || current.status === "approved") && current.endDate <= today) {
    const roleResult = settings.autoRemoveAbsenceRole
      ? await removeAbsenceRole(guild, settings, current)
      : { ok: false, reason: "Remocao automatica do cargo desativada na dashboard." };
    current = await context.api.markFivemFacAbsenceFinished(current.id, roleResult.ok);
    await sendFacLog(guild, settings, roleResult.ok ? "Cargo removido" : "Ausencia finalizada sem remover cargo", current, null, roleResult.reason);
    await sendFacLog(guild, settings, "Ausencia finalizada", current, null);
    const dmSent = await notifyAbsenceFinishedUser(guild, current, roleResult.ok, roleResult.reason);
    if (!dmSent) {
      await sendFacLog(guild, settings, "Erro ao enviar DM", current, null, "DM fechada ou indisponivel.");
    }
    await updateStoredAbsenceMessage(guild, current);
  }
}

async function addAbsenceRole(guild: Guild, settings: FivemFacSettings, absence: FivemFacAbsence): Promise<RoleChangeResult> {
  if (!settings.absenceRoleId) {
    return { ok: false, reason: "Cargo de ausencia nao configurado." };
  }

  const role = await guild.roles.fetch(settings.absenceRoleId).catch(() => null);

  if (!role) {
    return { ok: false, reason: "Cargo de ausencia nao existe ou nao foi encontrado." };
  }

  if (!role.editable) {
    return { ok: false, reason: "Bot sem permissao para gerenciar o cargo de ausencia ou cargo acima do bot." };
  }

  const member = await guild.members.fetch(absence.userId).catch(() => null);

  if (!member) {
    return { ok: false, reason: "Usuario saiu do servidor ou nao foi encontrado." };
  }

  if (member.roles.cache.has(settings.absenceRoleId)) {
    return { ok: true };
  }

  await member.roles.add(settings.absenceRoleId, "Inicio de ausencia FAC");
  return { ok: true };
}

async function removeAbsenceRole(guild: Guild, settings: FivemFacSettings, absence: FivemFacAbsence): Promise<RoleChangeResult> {
  if (!settings.absenceRoleId) {
    return { ok: false, reason: "Cargo de ausencia nao configurado." };
  }

  const role = await guild.roles.fetch(settings.absenceRoleId).catch(() => null);

  if (!role) {
    return { ok: false, reason: "Cargo de ausencia nao existe ou nao foi encontrado." };
  }

  if (!role.editable) {
    return { ok: false, reason: "Bot sem permissao para gerenciar o cargo de ausencia ou cargo acima do bot." };
  }

  const member = await guild.members.fetch(absence.userId).catch(() => null);

  if (!member) {
    return { ok: false, reason: "Usuario saiu do servidor ou nao foi encontrado." };
  }

  if (!member.roles.cache.has(settings.absenceRoleId)) {
    return { ok: true };
  }

  await member.roles.remove(settings.absenceRoleId, "Fim de ausencia FAC");
  return { ok: true };
}

async function updateAbsenceMessage(interaction: ButtonInteraction | ModalSubmitInteraction, settings: FivemFacSettings, absence: FivemFacAbsence) {
  if (interaction.isMessageComponent() && interaction.message.editable) {
    await interaction.message.edit(buildAbsenceMessagePayload(absence)).catch(() => null);
    return;
  }

  if (interaction.guild) {
    await updateStoredAbsenceMessage(interaction.guild, absence);
  }
}

async function updateStoredAbsenceMessage(guild: Guild, absence: FivemFacAbsence) {
  if (!absence.privateChannelId || !absence.requestMessageId) {
    return;
  }

  const channel = await guild.channels.fetch(absence.privateChannelId).catch(() => null);

  if (!channel?.isTextBased()) {
    return;
  }

  const message = await channel.messages.fetch(absence.requestMessageId).catch(() => null);
  await message?.edit(buildAbsenceMessagePayload(absence)).catch(() => null);
}

async function updateFivemFacAbsenceMessage(client: Client, absence: FivemFacAbsence) {
  const guild = await client.guilds.fetch(absence.guildId).catch(() => null);

  if (!guild) {
    return;
  }

  await updateStoredAbsenceMessage(guild, absence);
}

async function sendFacLog(
  guild: Guild,
  settings: FivemFacSettings,
  title: string,
  absence: FivemFacAbsence | null,
  actorId: string | null,
  reason?: string | null
) {
  if (!settings.logChannelId) {
    return;
  }

  const channel = await guild.channels.fetch(settings.logChannelId).catch(() => null);

  if (!channel?.isTextBased()) {
    return;
  }

  const lines = [`# FAC - ${title}`];
  if (absence) {
    lines.push(
      `**Usuario:** <@${absence.userId}>`,
      `**ID Discord:** ${absence.userId}`,
      `**Status:** ${statusLabel(absence.status)}`,
      `**Inicio:** ${formatDateOnly(absence.startDate)}`,
      `**Termino:** ${formatDateOnly(absence.endDate)}`,
      `**Moderador:** ${actorId ? `<@${actorId}>` : absence.moderatorId ? `<@${absence.moderatorId}>` : "Automatico"}`,
      `**Motivo:** ${truncate(absence.reason, 900)}`
    );

    if (reason || absence.rejectionReason) {
      lines.push(`**Detalhe:** ${truncate(reason ?? absence.rejectionReason ?? "", 900)}`);
    }
  } else if (actorId) {
    lines.push(`**Responsavel:** <@${actorId}>`);
  }
  lines.push(`**Data:** <t:${Math.floor(Date.now() / 1000)}:F>`);

  await channel.send({
    allowedMentions: { parse: [] },
    components: [{ type: 17, accent_color: 0x2b2d31, components: [{ type: 10, content: lines.join("\n") }] }],
    flags: MessageFlags.IsComponentsV2
  }).catch(() => null);
}

async function notifyAbsenceUser(guild: Guild, absence: FivemFacAbsence, message: string) {
  const user = await guild.client.users.fetch(absence.userId).catch(() => null);
  let dmSent = false;

  if (user) {
    dmSent = await user.send(buildAbsenceDmPayload("📅 Ausencia", message, statusLabel(absence.status), 0x2b2d31)).then(() => true).catch(() => false);
  }

  if (!absence.privateChannelId) {
    return dmSent;
  }

  const channel = await guild.channels.fetch(absence.privateChannelId).catch(() => null);

  if (channel?.isTextBased()) {
    await channel.send(`<@${absence.userId}> ${message}`).catch(() => null);
  }

  return dmSent;
}

async function notifyAbsenceFinishedUser(guild: Guild, absence: FivemFacAbsence, roleRemoved: boolean, reason?: string | null) {
  const user = await guild.client.users.fetch(absence.userId).catch(() => null);
  const message = roleRemoved
    ? [
        "Sua ausencia chegou ao fim.",
        "",
        "O cargo de ausencia foi removido automaticamente.",
        "",
        "Voce ja esta liberado para voltar ao trabalho e retornar ao RP."
      ].join("\n")
    : [
        "Sua ausencia chegou ao fim.",
        "",
        "O cargo de ausencia nao foi removido automaticamente.",
        reason ? `Motivo: ${reason}` : null,
        ""
      ].filter(Boolean).join("\n");

  let dmSent = false;

  if (user) {
    dmSent = await user.send(buildAbsenceDmPayload("🔔 Ausência Finalizada", [
      "Sua ausência chegou ao fim e o cargo de ausência foi removido automaticamente.",
      "",
      `👤 **Usuário:** <@${absence.userId}>`,
      `📆 **Data de retorno:** ${formatDateOnly(absence.endDate)}`,
      `🎖️ **Cargo removido:** ${roleRemoved ? "Sim" : "Nao"}`,
      `🕒 **Finalizado automaticamente em:** <t:${Math.floor(Date.now() / 1000)}:F>`,
      reason && !roleRemoved ? `📝 **Detalhe:** ${reason}` : null
    ].filter(Boolean).join("\n"), "Finalizada", roleRemoved ? 0x22c55e : 0xf59e0b)).then(() => true).catch(() => false);
  }

  if (!absence.privateChannelId) {
    return;
  }

  const channel = await guild.channels.fetch(absence.privateChannelId).catch(() => null);

  if (channel?.isTextBased()) {
    await channel.send(`<@${absence.userId}> ${message}`).catch(() => null);
  }

  return dmSent;
}

async function notifyApprovalUser(guild: Guild, settings: FivemFacSettings, absence: FivemFacAbsence, moderatorId: string, roleResult: RoleChangeResult) {
  const roleLabel = settings.absenceRoleId ? `<@&${settings.absenceRoleId}>` : "Cargo nao configurado";
  const detail = roleResult.ok ? roleLabel : `${roleLabel} (falha: ${roleResult.reason ?? "motivo nao informado"})`;
  const user = await guild.client.users.fetch(absence.userId).catch(() => null);

  if (!user) return false;

  return user.send(buildAbsenceDmPayload("✅ Ausência Aprovada", [
    "Sua solicitação de ausência foi aprovada com sucesso.",
    "",
    `👤 **Usuário:** <@${absence.userId}>`,
    `📅 **Início da ausência:** ${formatDateOnly(absence.startDate)}`,
    `📆 **Retorno previsto:** ${formatDateOnly(absence.endDate)}`,
    `🎖️ **Cargo recebido:** ${detail}`,
    `👮 **Aprovado por:** <@${moderatorId}>`,
    `🕒 **Data da aprovação:** <t:${Math.floor(Date.now() / 1000)}:F>`
  ].join("\n"), "Aprovada", 0x22c55e)).then(() => true).catch(() => false);
}

async function notifyRejectionUser(guild: Guild, absence: FivemFacAbsence, moderatorId: string, reason: string) {
  const user = await guild.client.users.fetch(absence.userId).catch(() => null);

  if (!user) return false;

  return user.send(buildAbsenceDmPayload("❌ Ausência Recusada", [
    "Sua solicitação de ausência foi recusada.",
    "",
    `👤 **Usuário:** <@${absence.userId}>`,
    `📅 **Início solicitado:** ${formatDateOnly(absence.startDate)}`,
    `📆 **Retorno solicitado:** ${formatDateOnly(absence.endDate)}`,
    `👮 **Recusado por:** <@${moderatorId}>`,
    `🕒 **Data da recusa:** <t:${Math.floor(Date.now() / 1000)}:F>`,
    `📝 **Motivo:** ${truncate(reason, 800)}`
  ].join("\n"), "Recusada", 0xef4444)).then(() => true).catch(() => false);
}

function buildAbsenceDmPayload(title: string, message: string, status: string, accentColor: number) {
  return {
    allowedMentions: { parse: [] as never[] },
    components: [{
      type: 17,
      accent_color: accentColor,
      components: [{
        type: 10,
        content: [
          `# ${title}`,
          message,
          "",
          `**Status:** ${status}`
        ].join("\n")
      }]
    }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function buildAbsenceMessagePayload(absence: FivemFacAbsence) {
  return {
    allowedMentions: { parse: [] as never[] },
    components: [
      {
        type: 17,
        accent_color: statusColor(absence.status),
        components: [{
          type: 10,
          content: [
            "# 📋 Solicitação de Ausência",
            "",
            `👤 **Solicitante:** <@${absence.userId}>`,
            `🆔 **ID do Discord:** ${absence.userId}`,
            `📅 **Data de início:** ${formatDateOnly(absence.startDate)}`,
            `📆 **Data de retorno:** ${formatDateOnly(absence.endDate)}`,
            `📝 **Motivo:** ${truncate(absence.reason, 900)}`,
            `⏰ **Solicitado em:** <t:${Math.floor(new Date(absence.createdAt).getTime() / 1000)}:F>`,
            `📌 **Status atual:** ${statusLabel(absence.status)}`,
            absence.moderatorId ? `👮 **Responsável:** <@${absence.moderatorId}>` : null,
            absence.rejectionReason ? `❌ **Motivo da recusa:** ${truncate(absence.rejectionReason, 800)}` : null
          ].filter(Boolean).join("\n")
        }]
      },
      ...buildAbsenceComponents(absence)
    ],
    embeds: [],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function buildPanelPayload(settings: FivemFacSettings) {
  const panelComponents: Array<Record<string, unknown>> = [
    {
      type: 10,
      content: [
        `# ${settings.messages.panelTitle || "🕒 Sistema de Ausência"}`,
        settings.messages.panelDescription || "Clique no botão abaixo para solicitar sua ausência. Informe a data de início, data de retorno e o motivo. Sua solicitação será enviada para análise da staff.",
        "",
        "**Status:** sistema ativo",
        "**Análise:** a staff irá revisar sua solicitação.",
        "**Retorno:** o cargo de ausência será removido automaticamente quando a ausência acabar."
      ].join("\n")
    }
  ];
  if (settings.panelVisual.enabledSections.image && settings.panelVisual.imageUrl && settings.panelVisual.imagePosition !== "none") {
    panelComponents.push({ type: 12, items: [{ media: { url: settings.panelVisual.imageUrl } }] });
  }
  return {
    allowedMentions: { parse: [] as never[] },
    components: [
      { type: 17, accent_color: panelColor(settings.panelVisual.panelColor), components: panelComponents },
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(REQUEST_BUTTON_ID)
          .setLabel("Solicitar Ausência")
          .setStyle(ButtonStyle.Primary)
      )
    ],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function panelColor(value: string | null | undefined) {
  const normalized = value?.trim().replace(/^#/, "");
  return normalized && /^[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized, 16) : 0x8b5cf6;
}

function buildAbsenceEmbed(absence: FivemFacAbsence) {
  const embed = new EmbedBuilder()
    .setColor(statusColor(absence.status))
    .setTitle("Solicitacao de Ausencia")
    .setDescription(absence.notes ? truncate(absence.notes, 1000) : "Sem observacoes adicionais.")
    .addFields(
      { name: "Usuario", value: `<@${absence.userId}>`, inline: true },
      { name: "Status", value: statusLabel(absence.status), inline: true },
      { name: "Periodo", value: `${formatDateOnly(absence.startDate)} ate ${formatDateOnly(absence.endDate)}`, inline: true },
      { name: "Duracao", value: `${absenceDurationDays(absence.startDate, absence.endDate)} dia(s)`, inline: true },
      { name: "Motivo", value: truncate(absence.reason, 1024), inline: false }
    )
    .setFooter({ text: `ID: ${absence.id}` })
    .setTimestamp(new Date(absence.updatedAt));

  if (absence.rejectionReason) {
    embed.addFields({ name: "Motivo da reprovacao", value: truncate(absence.rejectionReason, 1024), inline: false });
  }

  const photoUrl = toPublicImageUrl(absence.photoUrl);

  if (photoUrl) {
    embed.setImage(photoUrl);
  }

  return embed;
}

function buildAbsenceComponents(absence: FivemFacAbsence) {
  const closed = ["rejected", "finished", "closed"].includes(absence.status);
  const pending = absence.status === "pending";

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPROVE_PREFIX}:${absence.id}`)
        .setDisabled(!pending)
        .setLabel("Aprovar")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${REJECT_PREFIX}:${absence.id}`)
        .setDisabled(!pending)
        .setLabel("Reprovar")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${CLOSE_PREFIX}:${absence.id}`)
        .setDisabled(closed)
        .setLabel("Encerrar")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function hasApproverRole(interaction: ButtonInteraction | ModalSubmitInteraction, settings: FivemFacSettings) {
  if (interaction.guild?.ownerId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const allowed = new Set(settings.approverRoleIds);
  return interactionRoleIds(interaction).some((roleId) => allowed.has(roleId));
}

function hasMemberRole(interaction: ButtonInteraction | ModalSubmitInteraction, settings: FivemFacSettings) {
  const allowed = new Set(settings.memberRoleIds ?? []);

  if (!allowed.size) {
    return true;
  }

  return interactionRoleIds(interaction).some((roleId) => allowed.has(roleId));
}

function buildRequestSummaryPayload(
  token: string,
  request: Pick<PendingAbsenceRequest, "endDate" | "reason" | "startDate">
) {
  return {
    content: "",
    embeds: [
      new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle("Resumo da Ausência")
        .setDescription([
          `📅 **Início:** ${formatShortDateOnly(request.startDate)} (automático)`,
          `📅 **Retorno:** ${formatShortDateOnly(request.endDate)}`,
          `⏳ **Duração:** ${absenceDurationDays(request.startDate, request.endDate)} dia(s)`,
          `📝 **Motivo:** ${truncate(request.reason, 500)}`
        ].join("\n"))
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${CONFIRM_PREFIX}:${token}`)
          .setLabel("Enviar Solicitação")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`${CANCEL_PREFIX}:${token}`)
          .setLabel("Cancelar")
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function createPendingAbsenceRequest(request: PendingAbsenceRequest) {
  cleanupPendingAbsenceRequests();
  const token = randomUUID();
  pendingAbsenceRequests.set(token, request);
  return token;
}

function cleanupPendingAbsenceRequests() {
  const now = Date.now();

  for (const [token, request] of pendingAbsenceRequests) {
    if (now - request.createdAt > PENDING_REQUEST_TTL_MS) {
      pendingAbsenceRequests.delete(token);
    }
  }
}

function interactionRoleIds(interaction: ButtonInteraction | ModalSubmitInteraction) {
  const member = interaction.member;
  const roleIds = new Set<string>();

  if (interaction.guildId) {
    roleIds.add(interaction.guildId);
  }

  if (!member) {
    return [...roleIds];
  }

  if (member instanceof Object && "roles" in member) {
    const roles = member.roles;

    if (Array.isArray(roles)) {
      roles.forEach((roleId) => roleIds.add(roleId));
    } else if (roles instanceof Object && "cache" in roles) {
      [...(roles as GuildMember["roles"]).cache.keys()].forEach((roleId) => roleIds.add(roleId));
    }
  }

  return [...roleIds];
}

function normalizeBrazilianDateInput(value: string, today: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const explicitYear = match[3] ? Number(match[3]) : null;
  const currentYear = Number(today.slice(0, 4));
  let dateKey = dateKeyFromParts(explicitYear ?? currentYear, month, day);

  if (!dateKey) {
    return null;
  }

  if (!explicitYear && dateKey < today) {
    dateKey = dateKeyFromParts(currentYear + 1, month, day);
  }

  return dateKey;
}

function dateKeyFromParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function currentDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric"
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatAbsenceLine(absence: FivemFacAbsence) {
  return `**${statusLabel(absence.status)}** - ${formatDateOnly(absence.startDate)} ate ${formatDateOnly(absence.endDate)} - ${truncate(absence.reason, 90)}`;
}

function formatDateOnly(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatShortDateOnly(value: string) {
  const [, month, day] = value.split("-");
  return `${day}/${month}`;
}

function absenceDurationDays(startDate: string, endDate: string) {
  const start = dateKeyToUtcMs(startDate);
  const end = dateKeyToUtcMs(endDate);

  if (start === null || end === null || end < start) {
    return 0;
  }

  return Math.round((end - start) / 86_400_000);
}

function dateKeyToUtcMs(value: string) {
  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return Date.UTC(year, month - 1, day);
}

function toPublicImageUrl(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  const backendOrigin = env.BACKEND_API_URL ? new URL(env.BACKEND_API_URL).origin : "";
  return backendOrigin ? `${backendOrigin}${value.startsWith("/") ? value : `/${value}`}` : null;
}

function isFivemFacAbsencePayload(value: unknown): value is FivemFacAbsence {
  return Boolean(
    value
      && typeof value === "object"
      && "id" in value
      && "guildId" in value
      && "botId" in value
      && "userId" in value
  );
}

function statusLabel(status: FivemFacAbsence["status"]) {
  const labels: Record<FivemFacAbsence["status"], string> = {
    active: "Ativa",
    approved: "Aprovada",
    closed: "Encerrada",
    finished: "Finalizada",
    pending: "Pendente",
    rejected: "Reprovada"
  };

  return labels[status];
}

function statusColor(status: FivemFacAbsence["status"]) {
  const colors: Record<FivemFacAbsence["status"], number> = {
    active: 0x22c55e,
    approved: 0x3b82f6,
    closed: 0x71717a,
    finished: 0xa1a1aa,
    pending: 0xf59e0b,
    rejected: 0xef4444
  };

  return colors[status];
}

function sanitizeChannelName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "membro";
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isPayloadForThisBot(botId: string | null | undefined) {
  return !botId || !env.DASHBOARD_BOT_ID || botId === env.DASHBOARD_BOT_ID;
}

function panelRequestKey(guildId: string) {
  return `${env.DASHBOARD_BOT_ID || "bot"}:${guildId}`;
}

function rememberHandledPanelRequest(settings: FivemFacSettings) {
  if (settings.lastPanelRequestedAt) {
    handledPanelRequests.set(panelRequestKey(settings.guildId), settings.lastPanelRequestedAt);
  }
}

function logPanelRequestError(key: string, message: string, error: unknown) {
  const now = Date.now();
  const lastLogAt = panelRequestErrorLogAt.get(key) ?? 0;

  if (now - lastLogAt < 60_000) {
    return;
  }

  panelRequestErrorLogAt.set(key, now);
  console.warn(message, errorMessage(error));
}

async function replySafely(interaction: Interaction, content: string) {
  if (!interaction.isRepliable()) {
    return;
  }

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      content,
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content,
    ephemeral: true
  });
}

function readRequestErrorMessage(error: unknown) {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return null;
  }

  const response = (error as { response?: { data?: { message?: unknown } } }).response;
  return typeof response?.data?.message === "string" ? response.data.message : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
