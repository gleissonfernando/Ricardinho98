import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type UserSelectMenuInteraction
} from "discord.js";
import { currentRuntimeBotId } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import { renderComponentsV2Panel } from "./panelVisualRenderer";

const PREFIX = "remove_absence";

type AbsenceRemovalConfig = {
  allowedRoleIds: string[];
  approverRoleIds: string[];
  absenceRoleId: string | null;
  source: "RH" | "FAC";
};

export const removeCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("remover")
    .setDescription("Remove vínculos administrativos configurados.")
    .addSubcommand((command) => command
      .setName("ausencia")
      .setDescription("Remove o cargo de ausência de um membro.")),
  moduleId: "police-rh",
  async execute(interaction, context) {
    if (interaction.options.getSubcommand() !== "ausencia") return;
    await showRemoveAbsencePanel(interaction, context);
  }
};

export async function handleAbsenceRemovalInteraction(interaction: Interaction, context: BotContext) {
  if (!interaction.isUserSelectMenu() && !interaction.isButton()) return false;
  if (!interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guild) {
    if (interaction.isRepliable()) await interaction.reply({ content: "Use esta ação em um servidor.", ephemeral: true }).catch(() => null);
    return true;
  }

  const [, action, targetId] = interaction.customId.split(":");

  if (interaction.isUserSelectMenu() && action === "select") {
    await handleUserSelected(interaction, context);
    return true;
  }

  if (interaction.isButton() && action === "confirm" && targetId) {
    await handleConfirmRemoval(interaction, context, targetId);
    return true;
  }

  if (interaction.isButton() && action === "cancel") {
    await interaction.update(removeAbsenceCanceledPayload());
    return true;
  }

  return true;
}

async function showRemoveAbsencePanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  if (!interaction.guild) {
    await interaction.reply({ content: "Use este comando em um servidor.", ephemeral: true });
    return;
  }

  const config = await loadAbsenceRemovalConfig(interaction.guild.id, context);
  const permission = await canRemoveAbsence(interaction, config);
  if (!permission.ok) {
    await interaction.reply({ content: permission.reason, ephemeral: true });
    return;
  }

  await interaction.reply({
    ...removeAbsenceSelectPayload(config),
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });
}

async function handleUserSelected(interaction: UserSelectMenuInteraction, context: BotContext) {
  const config = await loadAbsenceRemovalConfig(interaction.guild!.id, context);
  const permission = await canRemoveAbsence(interaction, config);
  if (!permission.ok) {
    await interaction.reply({ content: permission.reason, ephemeral: true });
    return;
  }

  const targetId = interaction.values[0];
  if (!targetId) {
    await interaction.update(removeAbsenceErrorPayload("❌ Nenhum membro foi selecionado."));
    return;
  }
  const target = await interaction.guild!.members.fetch(targetId).catch(() => null);
  const role = config.absenceRoleId ? await interaction.guild!.roles.fetch(config.absenceRoleId).catch(() => null) : null;

  if (!target) {
    await interaction.update(removeAbsenceErrorPayload("❌ Membro não encontrado no servidor."));
    return;
  }
  if (!role) {
    await interaction.update(removeAbsenceErrorPayload("❌ Cargo de ausência não configurado ou removido."));
    return;
  }

  await interaction.update(removeAbsenceConfirmPayload({
    hasRole: target.roles.cache.has(role.id),
    roleId: role.id,
    source: config.source,
    targetId
  }));
}

async function handleConfirmRemoval(interaction: ButtonInteraction, context: BotContext, targetId: string) {
  await interaction.deferUpdate();

  const config = await loadAbsenceRemovalConfig(interaction.guild!.id, context);
  const permission = await canRemoveAbsence(interaction, config);
  if (!permission.ok) {
    await interaction.editReply(removeAbsenceErrorPayload(permission.reason));
    return;
  }

  if (!config.absenceRoleId) {
    await interaction.editReply(removeAbsenceErrorPayload("❌ Cargo de ausência não configurado."));
    return;
  }

  const guild = interaction.guild!;
  const role = await guild.roles.fetch(config.absenceRoleId).catch(() => null);
  const target = await guild.members.fetch(targetId).catch(() => null);
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);

  if (!role) {
    await interaction.editReply(removeAbsenceErrorPayload("❌ Cargo de ausência não existe mais no servidor."));
    return;
  }
  if (!target) {
    await interaction.editReply(removeAbsenceErrorPayload("❌ Membro não encontrado no servidor."));
    return;
  }
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
    await interaction.editReply(removeAbsenceErrorPayload("❌ O bot não tem permissão ou hierarquia para remover esse cargo."));
    return;
  }
  if (!target.roles.cache.has(role.id)) {
    await interaction.editReply(removeAbsenceSuccessPayload({
      detail: "O membro já não possui o cargo de ausência.",
      roleId: role.id,
      targetId
    }));
    return;
  }

  await target.roles.remove(role.id, `Remoção manual de ausência por ${interaction.user.tag}`);
  await context.api.postLog({
    guildId: guild.id,
    userId: interaction.user.id,
    type: "absence.role.manual_removed",
    message: "Cargo de ausência removido manualmente.",
    metadata: { roleId: role.id, targetId, source: config.source }
  }).catch(() => null);

  await interaction.editReply(removeAbsenceSuccessPayload({
    detail: "Cargo de ausência removido com sucesso.",
    roleId: role.id,
    targetId
  }));
}

async function loadAbsenceRemovalConfig(guildId: string, context: BotContext): Promise<AbsenceRemovalConfig> {
  const botId = currentRuntimeBotId();
  let rhConfig: Record<string, unknown> = {};
  if (botId) {
    const runtime = await context.api.getBotGuildConfig(botId, guildId).catch(() => null);
    rhConfig = runtime?.modules?.["police-rh"] ?? {};
  }

  const rhAbsenceRoleId = readSnowflake(rhConfig.absenceRoleId);
  if (rhAbsenceRoleId) {
    return {
      absenceRoleId: rhAbsenceRoleId,
      allowedRoleIds: idList(rhConfig.rhAllowedRoleIds),
      approverRoleIds: idList(rhConfig.absenceApproverRoleIds),
      source: "RH"
    };
  }

  const fac = await context.api.getFivemFacSettings(guildId).catch(() => null);
  return {
    absenceRoleId: fac?.absenceRoleId ?? null,
    allowedRoleIds: [],
    approverRoleIds: fac?.approverRoleIds ?? [],
    source: "FAC"
  };
}

async function canRemoveAbsence(interaction: ChatInputCommandInteraction | ButtonInteraction | UserSelectMenuInteraction, config: AbsenceRemovalConfig) {
  const guild = interaction.guild;
  if (!guild) return { ok: false, reason: "Use esta ação em um servidor." };
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const allowed = Boolean(
    guild.ownerId === interaction.user.id
    || member?.permissions.has(PermissionFlagsBits.Administrator)
    || member?.permissions.has(PermissionFlagsBits.ManageRoles)
    || [...config.allowedRoleIds, ...config.approverRoleIds].some((roleId) => member?.roles.cache.has(roleId))
  );

  return allowed
    ? { ok: true, reason: "" }
    : { ok: false, reason: "❌ Você não tem permissão para remover ausência." };
}

function removeAbsenceSelectPayload(config: AbsenceRemovalConfig) {
  const select = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`${PREFIX}:select`)
      .setPlaceholder("Selecione o membro para remover a ausência")
      .setMinValues(1)
      .setMaxValues(1)
  );

  return renderComponentsV2Panel({
    accentColor: 0xf59e0b,
    actions: [select],
    description: [
      "Selecione a pessoa que terá o cargo de ausência removido.",
      config.absenceRoleId ? `Cargo configurado: <@&${config.absenceRoleId}>` : "Cargo de ausência ainda não configurado."
    ].join("\n"),
    moduleId: "remove-absence",
    title: "📝 Remover ausência"
  });
}

function removeAbsenceConfirmPayload(input: { hasRole: boolean; roleId: string; source: string; targetId: string }) {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:confirm:${input.targetId}`).setEmoji("✅").setLabel("Confirmar remoção").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}:cancel`).setEmoji("❌").setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
  );

  return renderComponentsV2Panel({
    accentColor: input.hasRole ? 0xf59e0b : 0x5865f2,
    actions: [buttons],
    description: [
      `Membro selecionado: <@${input.targetId}>`,
      `Cargo de ausência: <@&${input.roleId}>`,
      `Origem da configuração: ${input.source}`,
      input.hasRole ? "Confirme para remover o cargo." : "Este membro não possui o cargo no momento."
    ].join("\n"),
    moduleId: "remove-absence",
    title: "⚠️ Confirmar remoção de ausência"
  });
}

function removeAbsenceSuccessPayload(input: { detail: string; roleId: string; targetId: string }) {
  return renderComponentsV2Panel({
    accentColor: 0x22c55e,
    description: [`Membro: <@${input.targetId}>`, `Cargo: <@&${input.roleId}>`, input.detail].join("\n"),
    moduleId: "remove-absence",
    title: "✅ Ausência removida"
  });
}

function removeAbsenceErrorPayload(description: string) {
  return renderComponentsV2Panel({
    accentColor: 0xef4444,
    description,
    moduleId: "remove-absence",
    title: "❌ Não foi possível remover ausência"
  });
}

function removeAbsenceCanceledPayload() {
  return renderComponentsV2Panel({
    accentColor: 0x6b7280,
    description: "A remoção de ausência foi cancelada. Nenhum cargo foi alterado.",
    moduleId: "remove-absence",
    title: "🔒 Ação cancelada"
  });
}

function idList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^\d{5,32}$/.test(item)) : [];
}

function readSnowflake(value: unknown) {
  return typeof value === "string" && /^\d{5,32}$/.test(value) ? value : null;
}
