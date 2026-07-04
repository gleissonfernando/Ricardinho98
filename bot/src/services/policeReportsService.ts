import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type Guild,
  type Interaction
} from "discord.js";
import { currentRuntimeBotId, isBotModuleEnabled } from "../config/env";
import type { BotCommand, BotContext } from "../types";
import { renderComponentsV2Panel } from "./panelVisualRenderer";

const MODULE_ID = "police-reports";
const PREFIX = "police_reports";
const PAGE_SIZE = 25;

type ComplaintType = { id: string; name: string; description: string | null; emoji: string | null; order: number };
type PoliceReportsConfig = {
  enabled: boolean;
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelTitle: string;
  panelDescription: string;
  buttonLabel: string;
  color: string;
  thumbnailUrl: string;
  complaintTypes: ComplaintType[];
};

export const policeReportsCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("config_denuncias")
    .setDescription("Gerencia o painel de denuncias EAB.")
    .addSubcommand((command) => command.setName("publicar").setDescription("Publica ou atualiza o painel configurado.")),
  moduleId: MODULE_ID,
  async execute(interaction, context) {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Voce precisa da permissao Gerenciar Servidor.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      await publishPoliceReportsPanel(interaction.guild, context, true);
      await interaction.editReply("Painel de denuncias publicado ou atualizado.");
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "Nao foi possivel publicar o painel.");
    }
  }
};

export function startPoliceReportsService(client: Client<true>, context: BotContext) {
  context.socket.onPoliceReportsPanelUpdate((payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (guild) void publishPoliceReportsPanel(guild, context, payload.action === "publish").catch((error) => {
      console.warn("[police-reports] falha ao atualizar painel:", error instanceof Error ? error.message : error);
    });
  });
}

export async function handlePoliceReportsInteraction(interaction: Interaction, context: BotContext) {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
  if (!interaction.guild || !isBotModuleEnabled(MODULE_ID)) return true;
  const config = await loadConfig(interaction.guild.id, context);
  if (!config) {
    await interaction.reply({ content: "A configuracao deste painel nao esta disponivel.", ephemeral: true });
    return true;
  }
  if (interaction.isStringSelectMenu()) {
    const selected = config.complaintTypes.find((item) => item.id === interaction.values[0]);
    await interaction.reply({ content: selected ? `Tipo selecionado: **${selected.name}**.` : "Este tipo de denuncia nao esta mais disponivel.", ephemeral: true });
    return true;
  }
  const page = Math.max(0, Number(interaction.customId.split(":")[2] ?? 0) || 0);
  await interaction.update(createPanelPayload(config, page));
  return true;
}

async function publishPoliceReportsPanel(guild: Guild, context: BotContext, allowCreate: boolean) {
  const config = await loadConfig(guild.id, context);
  if (!config?.enabled) throw new Error("Ative o Sistema de Denuncias EAB antes de publicar.");
  if (!config.complaintTypes.length) throw new Error("Cadastre ao menos um tipo de denuncia antes de publicar o painel.");
  if (!config.panelChannelId) throw new Error("Configure o canal do painel antes de publicar.");
  const channel = await guild.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel || !("messages" in channel) || !("send" in channel)) throw new Error("O canal configurado nao aceita mensagens.");
  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  if (message) {
    await message.edit(createPanelPayload(config, 0));
  } else if (allowCreate) {
    message = await channel.send(createPanelPayload(config, 0));
  }
  if (message && message.id !== config.panelMessageId) await context.api.updatePoliceReportsPanelState(guild.id, message.id);
}

async function loadConfig(guildId: string, context: BotContext): Promise<PoliceReportsConfig | null> {
  const botId = currentRuntimeBotId();
  if (!botId) return null;
  const runtime = await context.api.getBotGuildConfig(botId, guildId);
  const raw = runtime.modules[MODULE_ID] ?? {};
  const complaintTypes = Array.isArray(raw.complaintTypes)
    ? raw.complaintTypes.filter(isComplaintType).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    : [];
  return {
    enabled: raw.enabled === true,
    panelChannelId: readString(raw.panelChannelId),
    panelMessageId: readString(raw.panelMessageId),
    panelTitle: readString(raw.panelTitle) ?? "Sistema de Denuncias EAB",
    panelDescription: readString(raw.panelDescription) ?? "Registre uma denuncia de forma segura e sigilosa.",
    buttonLabel: readString(raw.buttonLabel) ?? "Selecionar denuncia",
    color: readString(raw.color) ?? "#7c3aed",
    thumbnailUrl: readString(raw.thumbnailUrl) ?? "",
    complaintTypes
  };
}

function createPanelPayload(config: PoliceReportsConfig, requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(config.complaintTypes.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount - 1);
  const visibleTypes = config.complaintTypes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:select:${page}`)
    .setPlaceholder(config.buttonLabel.slice(0, 150))
    .addOptions(visibleTypes.map(toSelectOption));
  const actions: unknown[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
  if (pageCount > 1) {
    actions.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:page:${Math.max(0, page - 1)}`).setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`${PREFIX}:page:${Math.min(pageCount - 1, page + 1)}`).setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1)
    ));
  }
  return renderComponentsV2Panel({
    accentColor: Number.parseInt(config.color.replace("#", ""), 16) || 0x7c3aed,
    actions,
    description: `${config.panelDescription}${pageCount > 1 ? `\n\nPagina ${page + 1} de ${pageCount}` : ""}`,
    fields: [],
    image: config.thumbnailUrl ? { imageEnabled: true, imagePosition: "thumbnail", imageUrl: config.thumbnailUrl } : null,
    moduleId: MODULE_ID,
    title: config.panelTitle
  });
}

function toSelectOption(item: ComplaintType) {
  const option = new StringSelectMenuOptionBuilder().setLabel(item.name.slice(0, 100)).setValue(item.id.slice(0, 100));
  if (item.description) option.setDescription(item.description.slice(0, 100));
  if (item.emoji) {
    try { option.setEmoji(item.emoji); } catch { /* Emoji invalido nao impede o painel. */ }
  }
  return option;
}

function isComplaintType(value: unknown): value is ComplaintType {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ComplaintType>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.order === "number";
}

function readString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
