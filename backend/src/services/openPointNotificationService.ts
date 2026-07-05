import { randomUUID } from "node:crypto";
import { getMongoCollections, type MongoOpenPointSettings } from "../database/mongo";

export async function getOpenPointSettings(botId: string, guildId: string) {
  const { openPointSettings } = await getMongoCollections();
  const existing = await openPointSettings.findOne({ botId, guildId });
  if (existing) return settingsDto(existing);
  const now = new Date();
  const value: MongoOpenPointSettings = {
    _id: randomUUID(),
    allowedRoleIds: [],
    botId,
    createdAt: now,
    dmBannerUrl: null,
    enabled: true,
    fineBannerUrl: null,
    fineChannelId: null,
    fineMode: "once_at_3",
    fineRoleId: null,
    guildId,
    justificationChannelId: null,
    logChannelId: null,
    updatedAt: now,
    updatedBy: null
  };
  await openPointSettings.updateOne({ botId, guildId }, { $setOnInsert: value }, { upsert: true });
  return settingsDto((await openPointSettings.findOne({ botId, guildId })) ?? value);
}

export async function saveOpenPointSettings(botId: string, guildId: string, input: Partial<Omit<MongoOpenPointSettings, "_id" | "botId" | "guildId" | "createdAt" | "updatedAt" | "updatedBy">>, actorId: string | null) {
  await getOpenPointSettings(botId, guildId);
  const { openPointSettings } = await getMongoCollections();
  await openPointSettings.updateOne({ botId, guildId }, { $set: { ...input, updatedAt: new Date(), updatedBy: actorId } });
  return settingsDto((await openPointSettings.findOne({ botId, guildId }))!);
}

export async function incrementOpenPointCounter(input: { appliedBy: string; botId: string; guildId: string; userId: string }) {
  const { openPointCounters } = await getMongoCollections();
  const now = new Date();
  await openPointCounters.updateOne(
    { botId: input.botId, guildId: input.guildId, userId: input.userId },
    {
      $inc: { totalNotifications: 1 },
      $push: { history: { appliedBy: input.appliedBy, at: now, reason: "Ponto em aberto" } },
      $set: { lastNotificationAt: now, updatedAt: now },
      $setOnInsert: { _id: randomUUID(), fineGeneratedAt: null, resetHistory: [] }
    },
    { upsert: true }
  );
  return counterDto((await openPointCounters.findOne({ botId: input.botId, guildId: input.guildId, userId: input.userId }))!);
}

export async function getOpenPointCounter(botId: string, guildId: string, userId: string) {
  const { openPointCounters } = await getMongoCollections();
  const value = await openPointCounters.findOne({ botId, guildId, userId });
  return value ? counterDto(value) : emptyCounter(botId, guildId, userId);
}

export async function markOpenPointFineGenerated(botId: string, guildId: string, userId: string) {
  const { openPointCounters } = await getMongoCollections();
  const now = new Date();
  await openPointCounters.updateOne({ botId, guildId, userId }, { $set: { fineGeneratedAt: now, updatedAt: now } });
  return getOpenPointCounter(botId, guildId, userId);
}

export async function resetOpenPointCounter(input: { botId: string; guildId: string; resetBy: string; userId: string }) {
  const { openPointCounters } = await getMongoCollections();
  const current = await openPointCounters.findOne({ botId: input.botId, guildId: input.guildId, userId: input.userId });
  const now = new Date();
  await openPointCounters.updateOne(
    { botId: input.botId, guildId: input.guildId, userId: input.userId },
    {
      $set: { fineGeneratedAt: null, history: [], lastNotificationAt: null, totalNotifications: 0, updatedAt: now },
      $push: { resetHistory: { at: now, previousTotal: current?.totalNotifications ?? 0, resetBy: input.resetBy } },
      $setOnInsert: { _id: randomUUID(), botId: input.botId, guildId: input.guildId, userId: input.userId }
    },
    { upsert: true }
  );
  return getOpenPointCounter(input.botId, input.guildId, input.userId);
}

function settingsDto(value: MongoOpenPointSettings) {
  return {
    ...value,
    id: value._id,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString()
  };
}

function counterDto(value: any) {
  return {
    ...value,
    id: value._id,
    fineGeneratedAt: value.fineGeneratedAt?.toISOString() ?? null,
    history: (value.history ?? []).map((item: any) => ({ ...item, at: item.at.toISOString() })),
    lastNotificationAt: value.lastNotificationAt?.toISOString() ?? null,
    resetHistory: (value.resetHistory ?? []).map((item: any) => ({ ...item, at: item.at.toISOString() })),
    updatedAt: value.updatedAt.toISOString()
  };
}

function emptyCounter(botId: string, guildId: string, userId: string) {
  return {
    botId,
    fineGeneratedAt: null,
    guildId,
    history: [],
    id: "",
    lastNotificationAt: null,
    resetHistory: [],
    totalNotifications: 0,
    updatedAt: new Date(0).toISOString(),
    userId
  };
}
