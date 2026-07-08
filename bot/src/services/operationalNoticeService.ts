import {
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type Message
} from "discord.js";
import type { OperationalNoticeState } from "./apiClient";
import { getCachedGuildSettings } from "./guildSettingsCache";
import type { BotContext, GuildSettings } from "../types";

type MessageChannelWithMessages = Message["channel"] & {
  messages: Message["channel"]["messages"];
  send: (payload: Parameters<Extract<Message["channel"], { send: unknown }>["send"]>[0]) => Promise<Message>;
};

const NOTICE_PANEL_TITLE = "AVISO DA ORVITECK";
const NOTICE_PANEL_MARKER = "ORVITECK_OPERATIONAL_NOTICE";
const DEFAULT_NOTICE_MESSAGE = "Orviteck informa: os bots ficarão offline por 3 dias por troca de hospedagem.";

let noticeState: OperationalNoticeState = {
  active: false,
  activatedAt: null,
  affectedBots: 0,
  deactivatedAt: null,
  message: DEFAULT_NOTICE_MESSAGE,
  updatedAt: new Date(0).toISOString(),
  updatedById: null,
  updatedByName: null
};
let started = false;
let appliedInitialNoticeState = false;

export async function refreshOperationalNoticeState(context: BotContext) {
  const previousActive = noticeState.active;
  const state = await context.api.getOperationalNoticeState().catch((error) => {
    console.warn("[operational-notice] não foi possível carregar estado:", error instanceof Error ? error.message : error);
    return null;
  });

  if (state) {
    noticeState = state;
    await applyOperationalNoticeState(context, previousActive);
  }
}

export function startOperationalNoticeService(context: BotContext) {
  if (started) return;
  started = true;

  void refreshOperationalNoticeState(context);

  context.socket.onOperationalNoticeUpdated((payload) => {
    const previousActive = noticeState.active;
    noticeState = payload.state;
    void applyOperationalNoticeState(context, previousActive, payload.action);
  });

  const interval = setInterval(() => {
    void refreshOperationalNoticeState(context);
  }, 60_000);

  interval.unref();
}

async function applyOperationalNoticeState(context: BotContext, previousActive: boolean, action = noticeState.active ? "operational-notice:started" : "operational-notice:ended") {
  const shouldPublish = noticeState.active && (!previousActive || action === "operational-notice:manual_alert" || action === "operational-notice:updated" || !appliedInitialNoticeState);
  const shouldRemove = !noticeState.active && (previousActive || !appliedInitialNoticeState);

  if (shouldPublish) {
    await ensureOperationalNoticePanels(context, noticeState.message);
  }

  if (shouldRemove) {
    await removeOperationalNoticePanels(context);
  }

  appliedInitialNoticeState = true;
}

async function ensureOperationalNoticePanels(context: BotContext, message: string) {
  const sentChannels = new Set<string>();

  for (const guild of context.client.guilds.cache.values()) {
    const settings = await getCachedGuildSettings(context, guild.id, context.client.user?.id).catch(() => null);
    if (!settings) continue;

    for (const channelId of operationalNoticeChannelIds(settings)) {
      const key = `${guild.id}:${channelId}`;
      if (sentChannels.has(key)) continue;
      sentChannels.add(key);

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased() && channel.isSendable() && "messages" in channel) {
        await ensureOperationalNoticePanel(channel as MessageChannelWithMessages, message).catch((error) => {
          console.warn("[operational-notice] falha ao publicar painel:", error instanceof Error ? error.message : error);
        });
      }
    }
  }
}

async function removeOperationalNoticePanels(context: BotContext) {
  const checkedChannels = new Set<string>();

  for (const guild of context.client.guilds.cache.values()) {
    const settings = await getCachedGuildSettings(context, guild.id, context.client.user?.id).catch(() => null);
    if (!settings) continue;

    for (const channelId of operationalNoticeChannelIds(settings)) {
      const key = `${guild.id}:${channelId}`;
      if (checkedChannels.has(key)) continue;
      checkedChannels.add(key);

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased() && "messages" in channel) {
        await deleteOperationalNoticePanelsFromChannel(channel as MessageChannelWithMessages).catch((error) => {
          console.warn("[operational-notice] falha ao apagar painel:", error instanceof Error ? error.message : error);
        });
      }
    }
  }
}

async function ensureOperationalNoticePanel(channel: MessageChannelWithMessages, message: string) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const panels = messages.filter((item) => isOperationalNoticePanelMessage(item));
  const currentPanel = panels.find((item) => isCurrentOperationalNoticePanelMessage(item, message));

  if (!currentPanel) {
    await channel.send(operationalNoticePanelPayload(message));
  }

  await Promise.allSettled(
    panels
      .filter((item) => item.id !== currentPanel?.id)
      .map((item) => item.delete())
  );
}

async function deleteOperationalNoticePanelsFromChannel(channel: MessageChannelWithMessages) {
  const messages = await channel.messages.fetch({ limit: 100 });
  await Promise.allSettled(
    messages
      .filter((item) => isOperationalNoticePanelMessage(item))
      .map((item) => item.delete())
  );
}

function operationalNoticePanelPayload(message: string) {
  return {
    allowedMentions: { parse: [] as never[] },
    components: [operationalNoticePanelComponent(message)],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function operationalNoticePanelComponent(message: string) {
  return new ContainerBuilder()
    .setAccentColor(0x0ea5e9)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${NOTICE_PANEL_MARKER}`),
      new TextDisplayBuilder().setContent(`## ${NOTICE_PANEL_TITLE}`),
      new TextDisplayBuilder().setContent(message),
      new TextDisplayBuilder().setContent("-# Este aviso não ativa modo de manutenção. Os bots continuam operando até nova comunicação.")
    );
}

function isOperationalNoticePanelMessage(message: Message) {
  if (message.author.id !== message.client.user?.id) return false;
  const serialized = serializedMessageComponents(message);
  return serialized.includes(NOTICE_PANEL_MARKER)
    || serialized.includes(NOTICE_PANEL_TITLE)
    || message.content.includes(NOTICE_PANEL_TITLE);
}

function isCurrentOperationalNoticePanelMessage(message: Message, noticeMessage: string) {
  const serialized = serializedMessageComponents(message);
  return message.flags.has(MessageFlags.IsComponentsV2)
    && serialized.includes(NOTICE_PANEL_MARKER)
    && serialized.includes(noticeMessage);
}

function serializedMessageComponents(message: Message) {
  try {
    return JSON.stringify(message.components.map((component) => component.toJSON()));
  } catch {
    return "";
  }
}

function operationalNoticeChannelIds(settings: GuildSettings) {
  return [
    settings.logChannelId,
    settings.welcomeChannelId,
    settings.welcomeDisplayChannelId,
    settings.safeBotChannelId,
    settings.safeBotLogChannelId
  ].filter((channelId): channelId is string => Boolean(channelId));
}
