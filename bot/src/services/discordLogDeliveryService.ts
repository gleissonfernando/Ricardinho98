import { EmbedBuilder, type Guild, type TextBasedChannel } from "discord.js";
import { currentRuntimeBotId, env, isBotModuleEnabled } from "../config/env";
import type { BotContext, LogCategory } from "../types";
import type { DiscordLogDispatchEvent } from "../websocket/socketClient";
import { getCachedGuildSettings } from "./guildSettingsCache";
import { automatedLogChannelForType } from "./automatedLogService";

const CATEGORY_LABELS: Record<LogCategory, string> = {
  members: "Membros",
  messages: "Mensagens",
  roles: "Cargos",
  moderation: "Moderacao",
  dashboard: "Dashboard",
  automation: "Automacoes"
};

const CATEGORY_COLORS: Record<LogCategory, number> = {
  members: 0x23a55a,
  messages: 0x5865f2,
  roles: 0xf0b232,
  moderation: 0xed4245,
  dashboard: 0x9b59b6,
  automation: 0x2b2d31
};

let started = false;

export function startDiscordLogDelivery(context: BotContext) {
  if (started) {
    return;
  }

  started = true;
  context.socket.onDiscordLogDispatch((log) => {
    void deliverDiscordLog(context, log);
  });
}

async function deliverDiscordLog(context: BotContext, log: DiscordLogDispatchEvent) {
  if (!isBotModuleEnabled("logs") || log.type === "audit.dev_bot" || !belongsToRuntime(log.botId)) {
    return;
  }

  const guild = context.client.guilds.cache.get(log.guildId);

  if (!guild) {
    return;
  }

  const settings = await getCachedGuildSettings(context, log.guildId, context.client.user?.id).catch(() => null);
  const category = logCategoryForType(log.type);

  if (!settings?.discordLogsEnabled || !settings.discordLogCategories.includes(category)) {
    return;
  }
  const automated = await context.api.getAutomatedLogSettings(guild.id).catch(() => null);
  const targetChannelId = automated?.enabled ? automatedLogChannelForType(automated, log.type) : settings.logChannelId;
  if (!targetChannelId) return;
  const channel = await guild.channels.fetch(targetChannelId).catch(() => null);

  if (!channel?.isTextBased() || !channel.isSendable()) {
    console.warn(`[logs] canal ${targetChannelId} indisponivel no servidor ${guild.id}.`);
    return;
  }

  const embed = await buildStandardLogEmbed(guild, channel, log, category);

  await channel.send({
    allowedMentions: {
      parse: []
    },
    embeds: [embed]
  }).catch((error) => {
    console.warn("[logs] falha ao enviar log no Discord:", error instanceof Error ? error.message : error);
  });
}

async function buildStandardLogEmbed(guild: Guild, deliveryChannel: TextBasedChannel, log: DiscordLogDispatchEvent, category: LogCategory) {
  const metadata = objectMetadata(log.metadata);
  const isCommand = log.type.toLowerCase().startsWith("commands.") || metadata.kind === "command";
  const embed = new EmbedBuilder()
    .setColor(isCommand ? 0x2b2d31 : colorForType(log.type, category))
    .setTitle(isCommand ? "Registro de Comando" : `Registro de ${logTitle(log)}`)
    .setFooter({ text: footerText(log, metadata) })
    .setTimestamp(new Date(log.createdAt));

  const actorId = stringValue(metadata.userId) ?? log.userId ?? null;

  if (actorId) {
    const member = await guild.members.fetch(actorId).catch(() => null);
    const user = member?.user ?? await guild.client.users.fetch(actorId).catch(() => null);
    embed.addFields({
      name: "Usuario",
      value: `${user ? `<@${actorId}> | ${displayName(user.username)}` : `<@${actorId}>`}\nID do Usuário: ${actorId}`,
      inline: false
    });
  }

  if (isCommand) {
    embed.addFields(
      { name: "Comando", value: `/${stringValue(metadata.commandName) ?? commandNameFromType(log.type) ?? "desconhecido"}`, inline: false },
      { name: "Opções", value: optionsText(metadata), inline: false },
      { name: "Canal", value: channelText(guild, stringValue(metadata.channelId), deliveryChannel), inline: false }
    );
    return embed;
  }

  embed.addFields(
    { name: "Evento", value: limitText(log.message, 1_000), inline: false },
    { name: "Tipo", value: `\`${limitText(log.type, 240)}\``, inline: false },
    { name: "Canal", value: channelText(guild, stringValue(metadata.channelId), deliveryChannel), inline: false }
  );

  for (const field of metadataFields(metadata)) {
    embed.addFields(field);
  }

  return embed;
}

function belongsToRuntime(botId: string | null) {
  const runtimeBotId = currentRuntimeBotId() ?? (env.DASHBOARD_BOT_ID.trim() || null);
  return runtimeBotId ? botId === runtimeBotId : botId === null;
}

function logCategoryForType(type: string): LogCategory {
  const normalized = type.trim().toLowerCase();

  if (normalized.startsWith("member.")) return "members";
  if (normalized.startsWith("message.")) return "messages";
  if (normalized.startsWith("roles.")) return "roles";
  if (
    normalized.startsWith("moderation.")
    || normalized.startsWith("security.")
    || normalized.startsWith("image_anti_spam.")
    || normalized.startsWith("self_bot_protection.")
  ) {
    return "moderation";
  }
  if (
    normalized.startsWith("dashboard.")
    || normalized.startsWith("audit.")
    || normalized.startsWith("access.")
  ) {
    return "dashboard";
  }

  return "automation";
}

function logTitle(log: DiscordLogDispatchEvent) {
  const titles: Record<string, string> = {
    "member.join": "Membro entrou",
    "member.leave": "Membro saiu",
    "message.delete": "Mensagem apagada",
    "message.update": "Mensagem editada",
    "message.bulk_delete": "Mensagens apagadas em massa",
    "voice.join": "🔊 Entrada em Call",
    "voice.leave": "🔇 Saída de Call",
    "voice.move": "🔁 Movimentação em Call",
    "voice.temporary_call": "🎧 Call Temporária",
    "roles.update": "Cargos atualizados",
    "dashboard.settings.updated": "Configuracao atualizada",
    "commands.executed": "Comando",
    "commands.failed": "Comando"
  };

  return titles[log.type] ?? CATEGORY_LABELS[logCategoryForType(log.type)];
}

function colorForType(type: string, category: LogCategory) {
  const value = type.toLowerCase();
  if (value.startsWith("voice.")) return 0x3b82f6;
  if (value.startsWith("message.") || value.includes("spam") || value.includes("link")) return 0xf97316;
  if (value.includes("verification")) return 0x22c55e;
  if (value.includes("absence") || value.includes("ausencia") || value.includes("fivem.fac")) return 0x8b5cf6;
  if (value.includes("punish") || value.includes("warning") || category === "moderation") return 0xef4444;
  if (category === "dashboard") return 0x27272a;
  return CATEGORY_COLORS[category];
}

function metadataFields(record: Record<string, unknown>) {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  addMetadataField(fields, "Conteudo", record.content);
  addMetadataField(fields, "Antes", record.before);
  addMetadataField(fields, "Depois", record.after);
  addMetadataField(fields, "Motivo", record.reason);
  addMetadataField(fields, "Cargos adicionados", record.added);
  addMetadataField(fields, "Cargos removidos", record.removed);
  addMetadataField(fields, "Canal", record.channelId);
  addMetadataField(fields, "Canal anterior", record.fromChannelId);
  addMetadataField(fields, "Novo canal", record.toChannelId);
  addMetadataField(fields, "ID da mensagem", record.messageId);
  addMetadataField(fields, "Tempo na call (segundos)", record.durationSeconds);

  return fields.slice(0, 3);
}

function addMetadataField(
  fields: Array<{ name: string; value: string; inline?: boolean }>,
  name: string,
  value: unknown
) {
  const formatted = formatMetadataValue(value);

  if (formatted) {
    fields.push({
      name,
      value: limitText(formatted, 500)
    });
  }
}

function formatMetadataValue(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean).join(", ");
  }

  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return "";
}

function objectMetadata(metadata: unknown) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function displayName(username: string) {
  return username.replace(/[`*_~|]/g, "");
}

function commandNameFromType(type: string) {
  const match = /^commands\.([^.]+)/i.exec(type.trim());
  return match?.[1] && !["executed", "failed"].includes(match[1]) ? match[1] : null;
}

function optionsText(metadata: Record<string, unknown>) {
  const options = metadata.options;

  if (options && typeof options === "object" && !Array.isArray(options)) {
    const lines = Object.entries(options as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${formatOptionValue(value)}`)
      .filter((line) => !line.endsWith(": "));

    if (lines.length) return limitText(lines.join("\n"), 1_000);
  }

  return "Sem opções.";
}

function formatOptionValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatOptionValue).filter(Boolean).join(", ");
  return "";
}

function channelText(guild: Guild, channelId: string | null, deliveryChannel: TextBasedChannel) {
  const id = channelId ?? ("id" in deliveryChannel ? deliveryChannel.id : null);
  const mention = id ? `<#${id}>` : "Canal não informado";
  return `${mention}\nServerId: ${guild.name}`;
}

function footerText(log: DiscordLogDispatchEvent, metadata: Record<string, unknown>) {
  const interactionId = stringValue(metadata.interactionId);
  const label = interactionId ? `ID da interação: ${interactionId}` : `ID do registro: ${log.id}`;
  return `${label} - ${formatFooterDate(log.createdAt)}`;
}

function formatFooterDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric"
  }).format(new Date(value));
}

function limitText(value: string, maxLength: number) {
  const normalized = value.trim() || "Evento registrado.";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}
