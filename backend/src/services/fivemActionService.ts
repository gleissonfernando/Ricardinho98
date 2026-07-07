import { randomUUID } from "node:crypto";
import {
  getMongoCollections,
  type MongoFivemActionArchitecture,
  type MongoFivemActionDefinition,
  type MongoFivemActionParticipant,
  type MongoFivemActionSettings
} from "../database/mongo";

export const FIVEM_ACTIONS_MODULE_ID = "fivem-actions";
export const POLICE_ACTIONS_MODULE_ID = "police-actions";

export type ActionSettingsInput = Partial<Pick<MongoFivemActionSettings,
  "enabled" | "categoryId" | "panelChannelId" | "actionChannelId" | "reportChannelId" |
  "categoryIds" | "panelChannelIds" | "actionChannelIds" | "reportChannelIds" |
  "panelTitle" | "panelDescription" | "color" | "imageUrl" | "imagePosition" | "panelMessageId" | "lastPanelRequestedAt"
>>;

export type ActionDefinitionInput = Partial<Pick<MongoFivemActionDefinition,
  "name" | "description" | "emoji" | "imageUrl" | "bannerUrl" | "color" | "authorizedRoleIds" |
  "destinationSystem" | "maxParticipants" | "enabled" | "order"
>>;

export async function getFivemActionDashboard(botId: string, guildId: string, architecture: MongoFivemActionArchitecture) {
  const { fivemActionDefinitions, fivemActionSessions } = await getMongoCollections();
  const [settings, actions, history] = await Promise.all([
    getFivemActionSettings(botId, guildId, architecture),
    fivemActionDefinitions.find({ botId, guildId, architecture }).sort({ order: 1, createdAt: 1 }).toArray(),
    fivemActionSessions.find({ botId, guildId, architecture }).sort({ createdAt: -1 }).limit(100).toArray()
  ]);
  return { settings: settingsDto(settings), actions: actions.map(actionDto), history: history.map(sessionDto) };
}

export async function getFivemActionSettings(botId: string, guildId: string, architecture: MongoFivemActionArchitecture) {
  const { fivemActionSettings } = await getMongoCollections();
  const existing = await fivemActionSettings.findOne({ botId, guildId, architecture });
  if (existing) return existing;
  const now = new Date();
  const settings: MongoFivemActionSettings = {
    _id: randomUUID(), botId, guildId, architecture, enabled: false, categoryId: null,
    categoryIds: [],
    panelChannelId: null, actionChannelId: null, reportChannelId: null, panelMessageId: null,
    panelChannelIds: [], actionChannelIds: [], reportChannelIds: [],
    panelTitle: architecture === "fac" ? "Ações da FAC" : "Operações da Polícia",
    panelDescription: "Escolha uma ação no menu abaixo para iniciar.", color: "#7c3aed",
    imageUrl: null, imagePosition: "none", lastPanelRequestedAt: null,
    createdAt: now, updatedAt: now, updatedBy: null
  };
  await fivemActionSettings.updateOne({ botId, guildId, architecture }, { $setOnInsert: settings }, { upsert: true });
  return (await fivemActionSettings.findOne({ botId, guildId, architecture })) ?? settings;
}

export async function saveFivemActionSettings(botId: string, guildId: string, architecture: MongoFivemActionArchitecture, input: ActionSettingsInput, actorId: string | null) {
  await getFivemActionSettings(botId, guildId, architecture);
  const { fivemActionSettings } = await getMongoCollections();
  const normalized = normalizeSettingsInput(input);
  await fivemActionSettings.updateOne({ botId, guildId, architecture }, { $set: { ...normalized, updatedAt: new Date(), updatedBy: actorId } });
  return settingsDto((await fivemActionSettings.findOne({ botId, guildId, architecture }))!);
}

export async function requestFivemActionPanel(botId: string, guildId: string, architecture: MongoFivemActionArchitecture, actorId: string) {
  const { fivemActionDefinitions } = await getMongoCollections();
  const settings = await getFivemActionSettings(botId, guildId, architecture);

  if (!settings.enabled) throw serviceError("Ative o Sistema de Ações antes de publicar.", 409);
  if (!idList(settings.panelChannelIds, settings.panelChannelId).length) throw serviceError("Configure pelo menos um canal para o painel principal.", 409);
  if (!idList(settings.actionChannelIds, settings.actionChannelId).length) throw serviceError("Configure pelo menos um canal para os painéis de ação.", 409);

  const hasActions = await fivemActionDefinitions.countDocuments({ botId, guildId, architecture, enabled: true });
  if (!hasActions) throw serviceError("Cadastre pelo menos uma ação ativa antes de publicar.", 409);

  return saveFivemActionSettings(botId, guildId, architecture, { lastPanelRequestedAt: new Date() }, actorId);
}

export async function updateFivemActionPanelState(botId: string, guildId: string, architecture: MongoFivemActionArchitecture, panelMessageId: string | null) {
  return saveFivemActionSettings(botId, guildId, architecture, { panelMessageId } as ActionSettingsInput, null);
}

export async function saveFivemActionDefinition(botId: string, guildId: string, architecture: MongoFivemActionArchitecture, actionId: string | null, input: ActionDefinitionInput, actorId: string) {
  const { fivemActionDefinitions, fivemActionSettings } = await getMongoCollections();
  const now = new Date();
  const id = actionId ?? randomUUID();
  const normalized = normalizeActionInput(input);

  if (actionId) {
    const updated = await fivemActionDefinitions.findOneAndUpdate(
      { _id: id, botId, guildId, architecture },
      { $set: { ...normalized, updatedAt: now } },
      { returnDocument: "after" }
    );
    if (!updated) throw serviceError("Ação não encontrada.", 404);
  } else {
    const doc: MongoFivemActionDefinition = {
      _id: id,
      botId,
      guildId,
      architecture,
      name: normalized.name ?? "Nova ação",
      description: normalized.description ?? "",
      emoji: normalized.emoji ?? null,
      imageUrl: normalized.imageUrl ?? null,
      bannerUrl: normalized.bannerUrl ?? null,
      color: normalized.color ?? "#7c3aed",
      authorizedRoleIds: normalized.authorizedRoleIds ?? [],
      destinationSystem: normalized.destinationSystem ?? null,
      maxParticipants: normalized.maxParticipants ?? 6,
      enabled: normalized.enabled ?? true,
      order: normalized.order ?? 0,
      createdAt: now,
      updatedAt: now,
      createdBy: actorId
    };
    await fivemActionDefinitions.insertOne(doc);
  }

  await fivemActionSettings.updateOne({ botId, guildId, architecture, panelMessageId: { $ne: null } }, { $set: { lastPanelRequestedAt: now, updatedAt: now, updatedBy: actorId } });
  return actionDto((await fivemActionDefinitions.findOne({ _id: id, botId, guildId, architecture }))!);
}

export async function deleteFivemActionDefinition(botId: string, guildId: string, architecture: MongoFivemActionArchitecture, actionId: string) {
  const { fivemActionDefinitions, fivemActionSettings } = await getMongoCollections();
  const deleted = await fivemActionDefinitions.findOneAndDelete({ _id: actionId, botId, guildId, architecture });
  if (deleted) await fivemActionSettings.updateOne({ botId, guildId, architecture, panelMessageId: { $ne: null } }, { $set: { lastPanelRequestedAt: new Date(), updatedAt: new Date() } });
  return deleted ? actionDto(deleted) : null;
}

export async function listActiveFivemActionSettings(botId: string, architectures?: MongoFivemActionArchitecture[]) {
  const { fivemActionSettings } = await getMongoCollections();
  const query = architectures?.length ? { botId, enabled: true, architecture: { $in: architectures } } : { botId, enabled: true };
  return (await fivemActionSettings.find(query).toArray()).map(settingsDto);
}

export async function createFivemActionSession(input: { botId: string; guildId: string; architecture: MongoFivemActionArchitecture; actionId: string; openerId: string; openerName: string; openerRoleIds?: string[] }) {
  const { fivemActionDefinitions, fivemActionSessions } = await getMongoCollections();
  const [settings, action] = await Promise.all([
    getFivemActionSettings(input.botId, input.guildId, input.architecture),
    fivemActionDefinitions.findOne({ _id: input.actionId, botId: input.botId, guildId: input.guildId, architecture: input.architecture, enabled: true })
  ]);
  if (!settings.enabled) throw serviceError("O Sistema de Ações está desativado na dashboard.", 403);
  if (!idList(settings.actionChannelIds, settings.actionChannelId).length) throw serviceError("Canal de ações não configurado.", 409);
  if (!action) throw serviceError("Ação não encontrada ou desativada.", 404);
  if (action.authorizedRoleIds.length && !normalizeIds(input.openerRoleIds).some((roleId) => action.authorizedRoleIds.includes(roleId))) {
    throw serviceError("Você não possui o cargo autorizado para esta ação.", 403);
  }
  const now = new Date();
  const { openerRoleIds: _openerRoleIds, ...sessionInput } = input;
  const session = { _id: randomUUID(), ...sessionInput, actionName: action.name, actionDescription: action.description, actionEmoji: action.emoji, actionImageUrl: action.imageUrl, actionColor: action.color, channelId: null, messageId: null, status: "active" as const, maxParticipants: action.maxParticipants, participants: [], startedAt: now, finishedAt: null, createdAt: now, updatedAt: now };
  await fivemActionSessions.insertOne(session);
  return sessionDto(session);
}

export async function updateFivemActionSessionMessage(botId: string, sessionId: string, channelId: string, messageId: string) {
  const { fivemActionSessions } = await getMongoCollections();
  await fivemActionSessions.updateOne({ _id: sessionId, botId }, { $set: { channelId, messageId, updatedAt: new Date() } });
  return sessionDto((await fivemActionSessions.findOne({ _id: sessionId, botId }))!);
}

export async function joinFivemActionSession(botId: string, sessionId: string, participant: Omit<MongoFivemActionParticipant, "joinedAt" | "leftAt">) {
  const { fivemActionSessions } = await getMongoCollections();
  const current = await fivemActionSessions.findOne({ _id: sessionId, botId });
  if (!current || current.status !== "active") throw serviceError("Esta ação não está mais ativa.", 409);
  if (current.participants.some((item) => item.userId === participant.userId && !item.leftAt)) return sessionDto(current);
  const activeCount = current.participants.filter((item) => !item.leftAt).length;
  if (activeCount >= current.maxParticipants) throw serviceError("A ação atingiu o limite de participantes.", 409);
  const updated = await fivemActionSessions.findOneAndUpdate({ _id: sessionId, botId, status: "active", participants: { $not: { $elemMatch: { userId: participant.userId, leftAt: null } } }, $expr: { $lt: [{ $size: { $filter: { input: "$participants", as: "p", cond: { $eq: ["$$p.leftAt", null] } } } }, "$maxParticipants"] } }, { $push: { participants: { ...participant, joinedAt: new Date(), leftAt: null } }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
  if (!updated) throw serviceError("A última vaga foi preenchida.", 409);
  return sessionDto(updated);
}

export async function leaveFivemActionSession(botId: string, sessionId: string, userId: string) {
  const { fivemActionSessions } = await getMongoCollections();
  await fivemActionSessions.updateOne({ _id: sessionId, botId, status: "active", participants: { $elemMatch: { userId, leftAt: null } } }, { $set: { "participants.$.leftAt": new Date(), updatedAt: new Date() } });
  const session = await fivemActionSessions.findOne({ _id: sessionId, botId });
  if (!session) throw serviceError("Ação não encontrada.", 404);
  return sessionDto(session);
}

export async function finishFivemActionSession(botId: string, sessionId: string, actorId: string, result: "victory" | "defeat") {
  const { fivemActionSessions } = await getMongoCollections();
  const now = new Date();
  const updated = await fivemActionSessions.findOneAndUpdate({ _id: sessionId, botId, status: "active", openerId: actorId }, { $set: { status: result, finishedAt: now, updatedAt: now } }, { returnDocument: "after" });
  if (updated) return sessionDto(updated);
  const session = await fivemActionSessions.findOne({ _id: sessionId, botId });
  if (!session) throw serviceError("Ação não encontrada.", 404);
  if (session.openerId !== actorId) throw serviceError("Você não é o responsável por esta ação.", 403);
  throw serviceError("Esta ação já foi encerrada.", 409);
}

export async function getFivemActionSession(botId: string, sessionId: string) {
  const { fivemActionSessions } = await getMongoCollections();
  const session = await fivemActionSessions.findOne({ _id: sessionId, botId });
  return session ? sessionDto(session) : null;
}

function settingsDto(value: MongoFivemActionSettings) {
  const panelChannelIds = idList(value.panelChannelIds, value.panelChannelId);
  const actionChannelIds = idList(value.actionChannelIds, value.actionChannelId);
  const reportChannelIds = idList(value.reportChannelIds, value.reportChannelId);
  const categoryIds = idList(value.categoryIds, value.categoryId);
  return {
    ...value,
    id: value._id,
    panelChannelId: panelChannelIds[0] ?? null,
    panelChannelIds,
    actionChannelId: actionChannelIds[0] ?? null,
    actionChannelIds,
    reportChannelId: reportChannelIds[0] ?? null,
    reportChannelIds,
    categoryId: categoryIds[0] ?? null,
    categoryIds,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    lastPanelRequestedAt: value.lastPanelRequestedAt?.toISOString() ?? null
  };
}
function actionDto(value: MongoFivemActionDefinition) { return { ...value, id: value._id, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() }; }
function sessionDto(value: any) { return { ...value, id: value._id, startedAt: value.startedAt.toISOString(), finishedAt: value.finishedAt?.toISOString() ?? null, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), participants: value.participants.map((item: MongoFivemActionParticipant) => ({ ...item, joinedAt: item.joinedAt.toISOString(), leftAt: item.leftAt?.toISOString() ?? null })) }; }
function normalizeSettingsInput(input: ActionSettingsInput) {
  const panelChannelIds = normalizeIds(input.panelChannelIds);
  const actionChannelIds = normalizeIds(input.actionChannelIds);
  const reportChannelIds = normalizeIds(input.reportChannelIds);
  const categoryIds = normalizeIds(input.categoryIds);
  return {
    ...input,
    ...(input.panelChannelIds ? { panelChannelIds, panelChannelId: panelChannelIds[0] ?? null } : {}),
    ...(input.actionChannelIds ? { actionChannelIds, actionChannelId: actionChannelIds[0] ?? null } : {}),
    ...(input.reportChannelIds ? { reportChannelIds, reportChannelId: reportChannelIds[0] ?? null } : {}),
    ...(input.categoryIds ? { categoryIds, categoryId: categoryIds[0] ?? null } : {}),
    ...(input.panelTitle !== undefined ? { panelTitle: normalizeText(input.panelTitle, 120, "Painel de Ações") } : {}),
    ...(input.panelDescription !== undefined ? { panelDescription: normalizeText(input.panelDescription, 1500, "") } : {}),
    ...(input.color !== undefined ? { color: normalizeColor(input.color, "#7c3aed") } : {}),
    ...(input.imageUrl !== undefined ? { imageUrl: normalizeNullableUrl(input.imageUrl) } : {})
  };
}

function normalizeActionInput(input: ActionDefinitionInput): ActionDefinitionInput {
  return {
    ...input,
    ...(input.name !== undefined ? { name: normalizeText(input.name, 80, "Nova ação") } : {}),
    ...(input.description !== undefined ? { description: normalizeText(input.description, 1000, "") } : {}),
    ...(input.emoji !== undefined ? { emoji: normalizeNullableText(input.emoji, 80) } : {}),
    ...(input.imageUrl !== undefined ? { imageUrl: normalizeNullableUrl(input.imageUrl) } : {}),
    ...(input.bannerUrl !== undefined ? { bannerUrl: normalizeNullableUrl(input.bannerUrl) } : {}),
    ...(input.color !== undefined ? { color: normalizeColor(input.color, "#7c3aed") } : {}),
    ...(input.authorizedRoleIds !== undefined ? { authorizedRoleIds: normalizeIds(input.authorizedRoleIds).slice(0, 50) } : {}),
    ...(input.destinationSystem !== undefined ? { destinationSystem: normalizeNullableText(input.destinationSystem, 100) } : {}),
    ...(input.maxParticipants !== undefined ? { maxParticipants: clampInt(input.maxParticipants, 1, 100, 6) } : {}),
    ...(input.order !== undefined ? { order: clampInt(input.order, 0, 10000, 0) } : {})
  };
}

function idList(values: unknown, fallback: string | null | undefined) {
  return [...new Set([...(Array.isArray(values) ? values : []), fallback].filter((value): value is string => typeof value === "string" && /^\d{5,32}$/.test(value)))];
}
function normalizeIds(values: unknown) { return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === "string" && /^\d{5,32}$/.test(value)))] : []; }
function normalizeText(value: unknown, maxLength: number, fallback: string) { return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback; }
function normalizeNullableText(value: unknown, maxLength: number) { return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null; }
function normalizeNullableUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().slice(0, 2048);
  return /^https?:\/\//i.test(normalized) || normalized.startsWith("/uploads/") ? normalized : null;
}
function normalizeColor(value: unknown, fallback: string) { return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : fallback; }
function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}
function serviceError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }
