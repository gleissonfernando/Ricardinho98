import { randomUUID } from "node:crypto";
import { ensureGuild, getMongoCollections, type MongoTicket } from "../database/mongo";

export type TicketDto = {
  id: string;
  botId: string | null;
  guildId: string;
  channelId?: string | null;
  openerId: string;
  authorId?: string;
  anonymous?: boolean;
  ticketType?: string;
  subject: string;
  status: "OPEN" | "PENDING" | "CLOSED" | "aberto" | "finalizado";
  createdAt: string;
  closedAt?: string | null;
};

const memoryTickets: TicketDto[] = [];

type CreateTicketInput = Pick<TicketDto, "guildId" | "channelId" | "openerId" | "subject"> & Partial<Pick<TicketDto, "anonymous" | "authorId" | "status" | "ticketType">> & {
  botId?: string | null;
};

export async function createTicket(input: CreateTicketInput) {
  const ticket: TicketDto = {
    id: randomUUID(),
    botId: normalizeBotId(input.botId),
    guildId: input.guildId,
    channelId: input.channelId,
    openerId: input.openerId,
    authorId: input.authorId ?? input.openerId,
    anonymous: input.anonymous ?? false,
    ticketType: input.ticketType,
    subject: input.subject,
    status: input.status ?? "OPEN",
    createdAt: new Date().toISOString(),
    closedAt: null
  };

  memoryTickets.unshift(ticket);

  try {
    await ensureGuild(input.guildId);

    const { tickets } = await getMongoCollections();
    const doc: MongoTicket = {
      _id: randomUUID(),
      botId: normalizeBotId(input.botId),
      guildId: input.guildId,
      channelId: input.channelId ?? null,
      openerId: input.openerId,
      authorId: input.authorId ?? input.openerId,
      anonymous: input.anonymous ?? false,
      ticketType: input.ticketType,
      subject: input.subject,
      status: input.status ?? "OPEN",
      createdAt: new Date(),
      closedAt: null
    };

    await tickets.insertOne(doc);

    return {
      ...ticket,
      id: doc._id,
      botId: normalizeBotId(doc.botId),
      channelId: doc.channelId,
      status: doc.status,
      createdAt: doc.createdAt.toISOString()
    };
  } catch (error) {
    console.warn("[mongo] ticket mantido em memória:", error instanceof Error ? error.message : error);
    return ticket;
  }
}

export async function listTickets(guildId?: string, botId?: string | null) {
  const normalizedBotId = normalizeBotId(botId);

  try {
    const { tickets } = await getMongoCollections();
    const rows = await tickets
      .find(scopedQuery(guildId, normalizedBotId))
      .sort({
        createdAt: -1
      })
      .limit(50)
      .toArray();

    return rows.map((ticket) => ({
      id: ticket._id,
      botId: normalizeBotId(ticket.botId),
      guildId: ticket.guildId,
      channelId: ticket.channelId,
      openerId: ticket.openerId,
      authorId: ticket.authorId ?? ticket.openerId,
      anonymous: ticket.anonymous ?? false,
      ticketType: ticket.ticketType,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: ticket.createdAt.toISOString(),
      closedAt: ticket.closedAt?.toISOString() ?? null
    }));
  } catch {
    return memoryTickets
      .filter((ticket) => (!guildId || ticket.guildId === guildId) && ticket.botId === normalizedBotId)
      .slice(0, 50);
  }
}

export async function updateTicketStatusByChannel(input: { botId?: string | null; channelId: string; guildId: string; status: "finalizado" }) {
  const botId = normalizeBotId(input.botId);
  const closedAt = new Date();
  const memoryTicket = memoryTickets.find((ticket) => ticket.botId === botId && ticket.guildId === input.guildId && ticket.channelId === input.channelId);
  if (memoryTicket) {
    memoryTicket.status = input.status;
    memoryTicket.closedAt = closedAt.toISOString();
  }
  try {
    const { tickets } = await getMongoCollections();
    await tickets.updateOne(
      { ...scopedQuery(input.guildId, botId), channelId: input.channelId },
      { $set: { closedAt, status: input.status } }
    );
  } catch (error) {
    console.warn("[mongo] status do ticket mantido em memoria:", error instanceof Error ? error.message : error);
  }
}

function normalizeBotId(botId: string | null | undefined) {
  const normalized = botId?.trim();
  return normalized ? normalized : null;
}

function scopedQuery(guildId: string | undefined, botId: string | null) {
  const botScope = botId
    ? { botId }
    : {
        $or: [
          {
            botId: null
          },
          {
            botId: {
              $exists: false
            }
          }
        ]
      };

  return guildId ? { guildId, ...botScope } : botScope;
}
