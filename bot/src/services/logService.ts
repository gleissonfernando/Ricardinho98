import type { ChatInputCommandInteraction, GuildMember, Message, PartialGuildMember, PartialMessage, ReadonlyCollection, Snowflake, User } from "discord.js";
import { currentRuntimeBotId } from "../config/env";
import type { BotContext } from "../types";

type CommandOptionData = {
  attachment?: { url: string };
  channel?: { id: string };
  name: string;
  options?: CommandOptionData[];
  role?: { id: string };
  user?: { id: string };
  value?: unknown;
};

export async function logMemberJoin(context: BotContext, member: GuildMember) {
  await sendLog(context, {
    guildId: member.guild.id,
    userId: member.id,
    type: "member.join",
    message: `${member.user.tag} entrou no servidor.`
  });
}

export async function logMemberLeave(context: BotContext, member: GuildMember | PartialGuildMember) {
  await sendLog(context, {
    guildId: member.guild.id,
    userId: member.id,
    type: "member.leave",
    message: `${member.user.tag} saiu do servidor.`
  });
}

export async function logMessageDelete(context: BotContext, message: Message | PartialMessage) {
  if (!message.guild || message.author?.bot) {
    return;
  }

  await sendLog(context, {
    guildId: message.guild.id,
    userId: message.author?.id,
    type: "message.delete",
    message: `Mensagem apagada em #${"name" in message.channel ? message.channel.name : message.channel.id}.`,
    metadata: {
      content: message.content || "Content unavailable",
      channelId: message.channelId,
      messageId: message.id
    }
  });
}

export async function logMessageUpdate(context: BotContext, oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) {
  if (!newMessage.guild || newMessage.author?.bot || oldMessage.content === newMessage.content) {
    return;
  }

  await sendLog(context, {
    guildId: newMessage.guild.id,
    userId: newMessage.author?.id,
    type: "message.update",
    message: "Mensagem editada.",
    metadata: {
      before: oldMessage.content,
      after: newMessage.content,
      channelId: newMessage.channelId,
      messageId: newMessage.id
    }
  });
}

export async function logMessageBulkDelete(context: BotContext, messages: ReadonlyCollection<Snowflake, Message | PartialMessage>) {
  const first = messages.first(); if (!first?.guild) return;
  await sendLog(context, { guildId: first.guild.id, type: "message.bulk_delete", message: `${messages.size} messages were deleted in bulk.`, metadata: { channelId: first.channelId, messageIds: [...messages.keys()].slice(0, 100) } });
}

export async function logRoleChange(context: BotContext, member: GuildMember, added: string[], removed: string[]) {
  if (!added.length && !removed.length) {
    return;
  }

  await sendLog(context, {
    guildId: member.guild.id,
    userId: member.id,
    type: "roles.update",
    message: `Cargos atualizados para ${member.user.tag}.`,
    metadata: {
      added,
      removed
    }
  });
}

export async function logModeration(context: BotContext, guildId: string, user: User, type: string, reason?: string) {
  await sendLog(context, {
    guildId,
    userId: user.id,
    type,
    message: `${user.tag}: ${reason ?? "acao registrada"}`,
    metadata: {
      reason
    }
  });
}

export function logCommandExecution(context: BotContext, interaction: ChatInputCommandInteraction, status: "executed" | "failed", error?: unknown) {
  if (!interaction.guildId) return;

  const commandName = interaction.commandName;
  const options = commandOptions(interaction);
  const message = status === "executed"
    ? `Comando /${commandName} executado.`
    : `Comando /${commandName} falhou.`;

  void sendLog(context, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    type: `commands.${status}`,
    message,
    metadata: {
      channelId: interaction.channelId,
      commandName,
      error: error instanceof Error ? error.message : undefined,
      interactionId: interaction.id,
      kind: "command",
      options,
      userId: interaction.user.id
    }
  });
}

async function sendLog(context: BotContext, payload: { guildId: string; type: string; message: string; userId?: string | null; metadata?: unknown }) {
  const scopedPayload = {
    ...payload,
    botId: currentRuntimeBotId()
  };

  try {
    await context.api.postLog(scopedPayload);
  } catch (error) {
    console.warn("[api] falha ao registrar log:", error instanceof Error ? error.message : error);

    if (isAuthorizationFailure(error)) {
      return;
    }

    context.socket.emitLog(scopedPayload);
  }
}

function isAuthorizationFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("response" in error)) {
    return false;
  }

  const response = (error as { response?: { status?: unknown } }).response;
  return response?.status === 401 || response?.status === 403 || response?.status === 404;
}

function commandOptions(interaction: ChatInputCommandInteraction) {
  const entries: Record<string, string> = {};

  for (const option of interaction.options.data) {
    readOption(option.name, option as CommandOptionData, entries);
  }

  return entries;
}

function readOption(name: string, option: CommandOptionData, entries: Record<string, string>) {
  if (option.options?.length) {
    for (const child of option.options) {
      readOption(child.name, child, entries);
    }
    return;
  }

  const value = option.user?.id
    ?? option.role?.id
    ?? option.channel?.id
    ?? option.attachment?.url
    ?? option.value;

  if (value !== undefined && value !== null) {
    entries[name] = String(value);
  }
}
