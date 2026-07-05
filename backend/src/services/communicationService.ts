import { randomUUID } from "node:crypto";
import {
  getMongoCollections,
  type MongoDmButton,
  type MongoDmSettings,
  type MongoSummonsSettings
} from "../database/mongo";

export const DM_MODULE_ID = "dm-system";
export const SUMMONS_MODULE_ID = "summons-system";

export async function getDmDashboard(botId: string, guildId: string) {
  const { dmLogs } = await getMongoCollections();
  const [settings, logs] = await Promise.all([
    getDmSettings(botId, guildId),
    dmLogs.find({ botId, guildId }).sort({ createdAt: -1 }).limit(100).toArray()
  ]);
  return { settings: dmSettingsDto(settings), logs: logs.map((item) => ({ ...item, id: item._id, createdAt: item.createdAt.toISOString() })) };
}

export async function getDmSettings(botId: string, guildId: string) {
  const { dmSettings } = await getMongoCollections();
  const existing = await dmSettings.findOne({ botId, guildId });
  if (existing) return existing;
  const now = new Date();
  const value: MongoDmSettings = {
    _id: randomUUID(), botId, guildId, enabled: false, authorizedRoleIds: [], logChannelId: null,
    bannerUrl: null, imageUrl: null, imagePosition: "none", color: "#7c3aed", teamName: "Equipe NPD", defaultTitle: "Mensagem da equipe",
    defaultText: "Você recebeu uma nova mensagem da equipe.", footerText: null, buttons: [], blockBots: true,
    saveContentInLogs: false,
    createdAt: now, updatedAt: now, updatedBy: null
  };
  await dmSettings.updateOne({ botId, guildId }, { $setOnInsert: value }, { upsert: true });
  return (await dmSettings.findOne({ botId, guildId })) ?? value;
}

export async function saveDmSettings(botId: string, guildId: string, input: Partial<Omit<MongoDmSettings, "_id" | "botId" | "guildId" | "createdAt" | "updatedAt" | "updatedBy">>, actorId: string | null) {
  await getDmSettings(botId, guildId);
  const { dmSettings } = await getMongoCollections();
  await dmSettings.updateOne({ botId, guildId }, { $set: { ...normalizeDmSettingsInput(input), updatedAt: new Date(), updatedBy: actorId } });
  return dmSettingsDto((await dmSettings.findOne({ botId, guildId }))!);
}

export async function recordDm(input: {
  botId: string; guildId: string; senderId: string; targetId: string; title: string;
  description: string; hasImage?: boolean; button: MongoDmButton | null; status: "sent" | "failed"; error?: string | null;
}) {
  const { dmLogs } = await getMongoCollections();
  const value = { _id: randomUUID(), ...input, error: input.error ?? null, createdAt: new Date() };
  await dmLogs.insertOne(value);
  return { ...value, id: value._id, createdAt: value.createdAt.toISOString() };
}

export async function getSummonsDashboard(botId: string, guildId: string) {
  const { summons } = await getMongoCollections();
  const [settings, history] = await Promise.all([
    getSummonsSettings(botId, guildId),
    summons.find({ botId, guildId }).sort({ createdAt: -1 }).limit(100).toArray()
  ]);
  return { settings: summonsSettingsDto(settings), history: history.map(summonsDto) };
}

export async function getSummonsSettings(botId: string, guildId: string) {
  const { summonsSettings } = await getMongoCollections();
  const existing = await summonsSettings.findOne({ botId, guildId });
  if (existing) return existing;
  const now = new Date();
  const value: MongoSummonsSettings = {
    _id: randomUUID(), botId, guildId, enabled: false, categoryId: null, temporaryCategoryId: null,
    authorizedRoleIds: [], moderatorRoleIds: [], anonymityEnabled: true, teamRoleIds: [],
    conselhoRoleIds: [], hcmdRoleIds: [], comissarioRoleIds: [], allowedCommandRoleIds: [],
    iabCategoryId: null, conselhoCategoryId: null, hcmdCategoryId: null, comissarioCategoryId: null,
    iabLogChannelId: null, conselhoLogChannelId: null, hcmdLogChannelId: null, comissarioLogChannelId: null,
    panelBannerUrl: null, defaultDeadline: null, teamAvatarUrl: null,
    privateLogChannelId: null, logChannelId: null, bannerUrl: null, color: "#f59e0b",
    publicResponsibleName: "Human Resources - NPD", dmTitle: "📨 Você recebeu uma intimação",
    dmDescription: "Você foi intimado para prestar esclarecimentos no canal indicado abaixo.",
    dmButtonText: "🔗 Acessar conversa",
    defaultMessage: "Este canal é confidencial e destinado à conversa com a Equipe IAB.", deleteDelaySeconds: 10,
    transcriptEnabled: true, createdAt: now, updatedAt: now, updatedBy: null
  };
  await summonsSettings.updateOne({ botId, guildId }, { $setOnInsert: value }, { upsert: true });
  return (await summonsSettings.findOne({ botId, guildId })) ?? value;
}

export async function saveSummonsSettings(botId: string, guildId: string, input: Partial<Omit<MongoSummonsSettings, "_id" | "botId" | "guildId" | "createdAt" | "updatedAt" | "updatedBy">>, actorId: string | null) {
  await getSummonsSettings(botId, guildId);
  const { summonsSettings } = await getMongoCollections();
  await summonsSettings.updateOne({ botId, guildId }, { $set: { ...input, updatedAt: new Date(), updatedBy: actorId } });
  return summonsSettingsDto((await summonsSettings.findOne({ botId, guildId }))!);
}

export async function createSummons(input: { botId: string; guildId: string; targetId: string; requesterId: string; reason: string; notes?: string | null; settingsSnapshot?: Record<string, unknown> }) {
  const { summons } = await getMongoCollections();
  const now = new Date();
  const value = {
    _id: randomUUID(), ...input, notes: input.notes ?? null, settingsSnapshot: input.settingsSnapshot ?? {}, channelId: null, panelMessageId: null,
    dmMessageId: null, dmDeliveryStatus: "pending" as const, dmDeliveryError: null,
    status: "creating" as const, transcript: null, createdAt: now, closedAt: null, closedBy: null,
    deleteAt: null, updatedAt: now
  };
  await summons.insertOne(value);
  return summonsDto(value);
}

export async function updateSummons(botId: string, id: string, patch: Record<string, unknown>) {
  const { summons } = await getMongoCollections();
  await summons.updateOne({ _id: id, botId }, { $set: { ...patch, updatedAt: new Date() } });
  const value = await summons.findOne({ _id: id, botId });
  if (!value) throw Object.assign(new Error("Intimação não encontrada."), { statusCode: 404 });
  return summonsDto(value);
}

export async function getSummonsByChannel(botId: string, channelId: string) {
  const { summons } = await getMongoCollections();
  const value = await summons.findOne({ botId, channelId, status: { $in: ["active", "closing"] } });
  return value ? summonsDto(value) : null;
}

export async function getSummons(botId: string, id: string) {
  const { summons } = await getMongoCollections();
  const value = await summons.findOne({ _id: id, botId });
  return value ? summonsDto(value) : null;
}

function dmSettingsDto(value: MongoDmSettings) {
  return {
    ...value,
    imageUrl: value.imageUrl ?? null,
    imagePosition: value.imagePosition ?? "none",
    teamName: value.teamName ?? "Equipe NPD",
    blockBots: value.blockBots ?? true,
    saveContentInLogs: value.saveContentInLogs ?? false,
    id: value._id,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString()
  };
}
function summonsSettingsDto(value: MongoSummonsSettings) {
  return {
    ...value,
    anonymityEnabled: value.anonymityEnabled ?? true,
    teamRoleIds: value.teamRoleIds ?? [],
    conselhoRoleIds: value.conselhoRoleIds ?? [],
    hcmdRoleIds: value.hcmdRoleIds ?? [],
    comissarioRoleIds: value.comissarioRoleIds ?? [],
    allowedCommandRoleIds: value.allowedCommandRoleIds ?? value.authorizedRoleIds ?? [],
    iabCategoryId: value.iabCategoryId ?? value.temporaryCategoryId ?? value.categoryId ?? null,
    conselhoCategoryId: value.conselhoCategoryId ?? value.temporaryCategoryId ?? value.categoryId ?? null,
    hcmdCategoryId: value.hcmdCategoryId ?? value.temporaryCategoryId ?? value.categoryId ?? null,
    comissarioCategoryId: value.comissarioCategoryId ?? value.temporaryCategoryId ?? value.categoryId ?? null,
    iabLogChannelId: value.iabLogChannelId ?? value.privateLogChannelId ?? value.logChannelId ?? null,
    conselhoLogChannelId: value.conselhoLogChannelId ?? value.privateLogChannelId ?? value.logChannelId ?? null,
    hcmdLogChannelId: value.hcmdLogChannelId ?? value.privateLogChannelId ?? value.logChannelId ?? null,
    comissarioLogChannelId: value.comissarioLogChannelId ?? value.privateLogChannelId ?? value.logChannelId ?? null,
    panelBannerUrl: value.panelBannerUrl ?? value.bannerUrl ?? null,
    defaultDeadline: value.defaultDeadline ?? null,
    teamAvatarUrl: value.teamAvatarUrl ?? null,
    privateLogChannelId: value.privateLogChannelId ?? null,
    publicResponsibleName: "Human Resources - NPD",
    dmTitle: "📨 Solicitação da Equipe IAB",
    dmDescription: "A Equipe IAB está solicitando sua presença para uma conversa.",
    dmButtonText: "🔗 Acessar conversa",
    defaultMessage: "Este canal é confidencial e destinado à conversa com a Equipe IAB.",
    id: value._id,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString()
  };
}
function summonsDto(value: any) {
  return {
    ...value, id: value._id, createdAt: value.createdAt.toISOString(),
    dmMessageId: value.dmMessageId ?? null,
    dmDeliveryStatus: value.dmDeliveryStatus ?? "pending",
    dmDeliveryError: value.dmDeliveryError ?? null,
    settingsSnapshot: value.settingsSnapshot ?? {},
    closedAt: value.closedAt?.toISOString() ?? null, deleteAt: value.deleteAt?.toISOString() ?? null,
    updatedAt: value.updatedAt.toISOString()
  };
}

function normalizeDmSettingsInput(input: Partial<Omit<MongoDmSettings, "_id" | "botId" | "guildId" | "createdAt" | "updatedAt" | "updatedBy">>) {
  const next: typeof input = { ...input };
  if ("bannerUrl" in next) next.bannerUrl = normalizeHttpsUrl(next.bannerUrl);
  if ("imageUrl" in next) next.imageUrl = normalizeImageUrl(next.imageUrl);
  if ("teamName" in next) next.teamName = normalizeText(next.teamName, "Equipe NPD", 80);
  if (next.buttons) {
    next.buttons = next.buttons
      .map((button) => ({ ...button, url: normalizeHttpsUrl(button.url) }))
      .filter((button) => button.style !== "link" || Boolean(button.url));
  }
  return next;
}

function normalizeText(value: string | null | undefined, fallback: string, maxLength: number) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function normalizeImageUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("https://")) return trimmed;
  throw Object.assign(new Error("Use uma URL HTTPS válida ou uma imagem enviada pelo upload."), { statusCode: 400 });
}

function normalizeHttpsUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("https://")) throw Object.assign(new Error("Use uma URL HTTPS válida para imagens e botões."), { statusCode: 400 });
  return trimmed;
}
