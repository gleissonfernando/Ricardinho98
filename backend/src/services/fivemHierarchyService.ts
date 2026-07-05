import { randomUUID } from "node:crypto";
import { ensureGuild, getMongoCollections, type MongoFivemHierarchyEntry, type MongoFivemHierarchyLog, type MongoFivemHierarchyPanel } from "../database/mongo";
import { devBotRealtimeRoom, emitRealtimeToRoom } from "../realtime/events";

export const FIVEM_HIERARCHY_MODULE_ID = "fivem-hierarchy";

export type FivemHierarchyEntryDto = {
  active: boolean;
  color: string | null;
  description: string | null;
  emoji: string | null;
  emptyText: string | null;
  id: string;
  limit: number | null;
  name: string;
  order: number;
  roleId: string;
  showWhenEmpty: boolean;
};

export type FivemHierarchyPanelDto = {
  botId: string | null;
  color: string;
  createdAt: string;
  description: string | null;
  displayMode: "mention" | "display_name" | "nickname" | "name_with_id";
  emptyText: string;
  enabled: boolean;
  editorRoleIds: string[];
  footerEnabled: boolean;
  footerIconUrl: string | null;
  footerScope: "unit" | "global";
  footerText: string | null;
  globalFooterIconUrl: string | null;
  globalFooterText: string | null;
  guildId: string;
  hierarchies: FivemHierarchyEntryDto[];
  id: string;
  imagePosition: "top" | "bottom" | "thumbnail" | "none";
  imageUrl: string | null;
  linkedToFivem: boolean;
  name: string;
  panelChannelId: string | null;
  panelMessageId: string | null;
  title: string;
  unitId: string;
  useGlobalFooter: boolean;
  updatedAt: string;
  updatedBy?: string | null;
};

export type FivemHierarchyLogDto = {
  action: string;
  botId: string | null;
  createdAt: string;
  details: Record<string, unknown>;
  guildId: string;
  id: string;
  panelId: string | null;
  userId: string | null;
};

export async function getFivemHierarchyDashboard(guildId: string, botId?: string | null) {
  await ensureDefaultHierarchyPanels(guildId, normalizeBotId(botId));
  return {
    logs: await listFivemHierarchyLogs(guildId, botId),
    panels: await listFivemHierarchyPanels(guildId, botId)
  };
}

export async function listFivemHierarchyPanels(guildId: string, botId?: string | null) {
  const { fivemHierarchyPanels } = await getMongoCollections();
  const rows = await fivemHierarchyPanels.find(scopeQuery(guildId, normalizeBotId(botId))).sort({ createdAt: -1 }).limit(50).toArray();
  return rows.map(toPanelDto);
}

export async function listActiveFivemHierarchyPanels(botId: string) {
  const { fivemHierarchyPanels } = await getMongoCollections();
  const rows = await fivemHierarchyPanels.find({ botId, enabled: true }).sort({ updatedAt: -1 }).toArray();
  return rows.map(toPanelDto);
}

export const DEFAULT_HIERARCHY_UNITS = [
  { unitId: "du", name: "DU", title: "Hierarquia - DU", description: "Lista de membros da unidade DU", color: "#1d4ed8", ranks: ["Chief of Detectives", "Assistant Chief", "Detective III", "Detective II", "Detective I", "DU Probationary"] },
  { unitId: "cbp", name: "CBP", title: "Hierarquia - CBP", description: "Lista de membros da unidade CBP", color: "#16a34a", ranks: ["CBP Commander", "CBP Deputy Commander", "CBP Customs Coordinator", "CBP Defense Agent III", "CBP Defense Agent II", "CBP Defense Agent I", "CBP Probationary Agent"] },
  { unitId: "traffic", name: "TRAFFIC", title: "Hierarquia - TRAFFIC", description: "Lista de membros da unidade TRAFFIC", color: "#7c3aed", ranks: ["Chief Of Traffic Enforcement", "Assistant Chief", "Coordinator", "Traffic Senior", "Traffic Officer", "Traffic Probationary"] },
  { unitId: "mary", name: "MARY", title: "Hierarquia - MARY", description: "Lista de membros da unidade MARY", color: "#52525b", ranks: ["MARY Commander", "MARY Deputy Commander", "MARY Coordinator", "MARY Veteran", "MARY Senior", "MARY Officer", "MARY Probationary"] },
  { unitId: "fast", name: "FAST", title: "Hierarquia - FAST", description: "Lista de membros da unidade FAST", color: "#eab308", ranks: ["Commander FAST", "FAST Deputy Commander", "FAST Coordinator", "FAST Veteran", "FAST Senior", "FAST Officer", "FAST Probationary"] },
  { unitId: "daf", name: "DAF", title: "Hierarquia - DAF", description: "Lista de membros da unidade DAF", color: "#d4d4d8", ranks: ["Commander D.A.F", "DAF Deputy Commander", "DAF Coordinator", "DAF Veteran", "DAF Senior", "DAF Officer", "DAF Probationary"] },
  { unitId: "swat", name: "SWAT", title: "HIERARQUIA SWAT", description: "Lista de membros da unidade SWAT", color: "#0f172a", ranks: ["COMMANDER", "DEPUTY COMMANDER", "COORDINATOR", "INSTRUCTOR", "OPERATOR", "PROBATORY"], swat: true }
] as const;

export async function getFivemHierarchyPanel(guildId: string, panelId: string, botId?: string | null) {
  const { fivemHierarchyPanels } = await getMongoCollections();
  const row = await fivemHierarchyPanels.findOne({ _id: panelId, ...scopeQuery(guildId, normalizeBotId(botId)) });
  return row ? toPanelDto(row) : null;
}

export async function saveFivemHierarchyPanel(guildId: string, botId: string | null, input: Partial<FivemHierarchyPanelDto>, actorId: string | null) {
  const normalizedBotId = normalizeBotId(botId);
  const now = new Date();
  const current = input.id ? await getRawPanel(guildId, input.id, normalizedBotId) : null;
  const panelId = current?._id ?? randomUUID();
  const mergedInput = current ? { ...toPanelDto(current), ...input } : input;
  const next: MongoFivemHierarchyPanel = {
    ...normalizePanelInput(mergedInput, guildId, normalizedBotId),
    _id: panelId,
    botId: normalizedBotId,
    createdAt: current?.createdAt ?? now,
    guildId,
    panelMessageId: current?.panelMessageId ?? normalizeSnowflake(input.panelMessageId),
    updatedAt: now,
    updatedBy: actorId
  };
  const { fivemHierarchyPanels } = await getMongoCollections();
  await ensureGuild(guildId);
  await fivemHierarchyPanels.updateOne(
    { _id: panelId, ...scopeQuery(guildId, normalizedBotId) },
    {
      $set: next,
      $unset: {
        allowedRoleIds: "",
        anonymousStaffAvatarUrl: "",
        anonymousStaffName: "",
        anonymousUserAvatarUrl: "",
        anonymousUserName: "",
        logChannelId: "",
        staffAnonymousEnabled: "",
        ticketAnonymousEnabled: "",
        ticketCategoryId: "",
        ticketMessageDeleteDelayMs: "",
        ticketResponderRoleIds: ""
      }
    },
    { upsert: true }
  );
  await writeFivemHierarchyLog({ action: current ? "panel.updated" : "panel.created", botId: normalizedBotId, details: { title: next.title }, guildId, panelId, userId: actorId });
  emitRealtimeToRoom(devBotRealtimeRoom(normalizedBotId ?? ""), "fivem:hierarchy:panel_update", { action: "update", botId: normalizedBotId, guildId, panelId });
  return toPanelDto(next);
}

export async function deleteFivemHierarchyPanel(guildId: string, botId: string | null, panelId: string, actorId: string | null) {
  const normalizedBotId = normalizeBotId(botId);
  const { fivemHierarchyPanels } = await getMongoCollections();
  const current = await fivemHierarchyPanels.findOne({ _id: panelId, ...scopeQuery(guildId, normalizedBotId) });
  if (!current) return null;
  await fivemHierarchyPanels.deleteOne({ _id: panelId, ...scopeQuery(guildId, normalizedBotId) });
  await writeFivemHierarchyLog({ action: "panel.deleted", botId: normalizedBotId, details: { title: current.title }, guildId, panelId, userId: actorId });
  return toPanelDto(current);
}

export async function requestFivemHierarchyPanelPublish(guildId: string, botId: string, panelId: string, actorId: string | null) {
  const panel = await getFivemHierarchyPanel(guildId, panelId, botId);
  if (!panel) throw new Error("Painel de hierarquia nao encontrado.");
  if (!panel.enabled) throw new Error("Ative o painel de hierarquia antes de publicar.");
  if (!panel.panelChannelId) throw new Error("Configure o canal do painel de hierarquia.");
  await writeFivemHierarchyLog({ action: "panel.publish_requested", botId, details: { channelId: panel.panelChannelId }, guildId, panelId, userId: actorId });
  emitRealtimeToRoom(devBotRealtimeRoom(botId), "fivem:hierarchy:panel_update", { action: "publish", botId, guildId, panelId });
  return panel;
}

export async function updateFivemHierarchyPanelState(guildId: string, botId: string | null, panelId: string, messageId: string | null) {
  const { fivemHierarchyPanels } = await getMongoCollections();
  const row = await fivemHierarchyPanels.findOneAndUpdate(
    { _id: panelId, ...scopeQuery(guildId, normalizeBotId(botId)) },
    { $set: { panelMessageId: normalizeSnowflake(messageId), updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return row ? toPanelDto(row) : null;
}

export async function listFivemHierarchyLogs(guildId: string, botId?: string | null, panelId?: string | null) {
  const { fivemHierarchyLogs } = await getMongoCollections();
  const rows = await fivemHierarchyLogs.find({ ...scopeQuery(guildId, normalizeBotId(botId)), ...(panelId ? { panelId } : {}) }).sort({ createdAt: -1 }).limit(200).toArray();
  return rows.map(toLogDto);
}

async function getRawPanel(guildId: string, panelId: string, botId: string | null) {
  const { fivemHierarchyPanels } = await getMongoCollections();
  return fivemHierarchyPanels.findOne({ _id: panelId, ...scopeQuery(guildId, botId) });
}

async function ensureDefaultHierarchyPanels(guildId: string, botId: string | null) {
  const { fivemHierarchyPanels } = await getMongoCollections();
  await ensureGuild(guildId);
  const existing = await fivemHierarchyPanels.find(scopeQuery(guildId, botId)).project<{ unitId?: string }>({ unitId: 1 }).toArray();
  const existingUnitIds = new Set(existing.map((item) => item.unitId).filter(Boolean));
  const now = new Date();
  const rows = DEFAULT_HIERARCHY_UNITS
    .filter((unit) => !existingUnitIds.has(unit.unitId))
    .map((unit): MongoFivemHierarchyPanel => {
      const panelId = `hierarchy-${unit.unitId}`;
      return {
        ...normalizePanelInput(defaultPanelDto(guildId, botId, panelId, unit), guildId, botId),
        _id: panelId,
        botId,
        createdAt: now,
        guildId,
        panelMessageId: null,
        updatedAt: now,
        updatedBy: null
      };
    });
  if (rows.length) await fivemHierarchyPanels.insertMany(rows, { ordered: false }).catch(() => null);
}

function defaultPanelDto(guildId: string, botId: string | null, id: string, unit: typeof DEFAULT_HIERARCHY_UNITS[number]): Partial<FivemHierarchyPanelDto> {
  return {
    botId,
    color: unit.color,
    description: unit.description,
    displayMode: "mention",
    emptyText: "Nenhum membro",
    enabled: false,
    editorRoleIds: [],
    footerEnabled: true,
    footerIconUrl: null,
    footerScope: "unit",
    footerText: "NPD - North Police Department",
    globalFooterIconUrl: null,
    globalFooterText: "NPD - North Police Department",
    guildId,
    hierarchies: unit.ranks.map((name, index) => ({
      active: true,
      color: null,
      description: null,
      emoji: "swat" in unit && unit.swat ? "•" : null,
      emptyText: "Nenhum membro",
      id: slugId(name),
      limit: null,
      name,
      order: index + 1,
      roleId: "",
      showWhenEmpty: true
    })),
    id,
    imagePosition: "thumbnail",
    imageUrl: null,
    linkedToFivem: true,
    name: unit.name,
    panelChannelId: null,
    panelMessageId: null,
    title: unit.title,
    unitId: unit.unitId,
    useGlobalFooter: false
  };
}

function normalizePanelInput(input: Partial<FivemHierarchyPanelDto>, guildId: string, botId: string | null): Omit<MongoFivemHierarchyPanel, "_id" | "createdAt" | "guildId" | "panelMessageId" | "updatedAt" | "updatedBy"> {
  return {
    botId,
    color: /^#[0-9a-f]{6}$/i.test(input.color ?? "") ? input.color ?? "#22c55e" : "#22c55e",
    description: normalizeText(input.description, 1200) ?? "Hierarquia atualizada automaticamente pelos cargos do servidor.",
    displayMode: normalizeDisplayMode(input.displayMode),
    emptyText: normalizeText(input.emptyText, 80) ?? "Nenhum membro",
    enabled: input.enabled === true,
    editorRoleIds: [...new Set((input.editorRoleIds ?? []).filter(Boolean))],
    footerEnabled: input.footerEnabled !== false,
    footerIconUrl: normalizeText(input.footerIconUrl, 2048),
    footerScope: input.footerScope === "global" ? "global" : "unit",
    footerText: normalizeText(input.footerText, 200),
    globalFooterIconUrl: normalizeText(input.globalFooterIconUrl, 2048),
    globalFooterText: normalizeText(input.globalFooterText, 200) ?? "NPD - North Police Department",
    hierarchies: normalizeHierarchies(input.hierarchies ?? []),
    imagePosition: input.imagePosition === "top" || input.imagePosition === "bottom" || input.imagePosition === "thumbnail" ? input.imagePosition : "none",
    imageUrl: normalizeText(input.imageUrl, 2048),
    linkedToFivem: input.linkedToFivem !== false,
    name: normalizeText(input.name, 100) ?? "Hierarquia FAQ",
    panelChannelId: normalizeSnowflake(input.panelChannelId),
    title: normalizeText(input.title, 120) ?? "Hierarquia Policial",
    unitId: normalizeText(input.unitId, 40)?.toLowerCase() ?? "custom",
    useGlobalFooter: input.useGlobalFooter === true || input.footerScope === "global"
  };
}

function normalizeHierarchies(values: Array<Partial<FivemHierarchyEntryDto> | MongoFivemHierarchyEntry>) {
  return (Array.isArray(values) ? values : [])
    .map((item, index) => ({
      active: item.active !== false,
      color: /^#[0-9a-f]{6}$/i.test(item.color ?? "") ? item.color ?? null : null,
      description: normalizeText(item.description, 300),
      emoji: normalizeText(item.emoji, 40),
      emptyText: normalizeText(item.emptyText, 80),
      id: normalizeText(item.id, 80) ?? randomUUID(),
      limit: typeof item.limit === "number" && Number.isFinite(item.limit) ? Math.max(1, Math.min(100, Math.trunc(item.limit))) : null,
      name: normalizeText(item.name, 80) ?? `Hierarquia ${index + 1}`,
      order: typeof item.order === "number" && Number.isFinite(item.order) ? Math.trunc(item.order) : index + 1,
      roleId: normalizeSnowflake(item.roleId) ?? "",
      showWhenEmpty: item.showWhenEmpty !== false
    }))
    .sort((a, b) => a.order - b.order)
    .slice(0, 50);
}

async function writeFivemHierarchyLog(input: Omit<MongoFivemHierarchyLog, "_id" | "createdAt">) {
  const { fivemHierarchyLogs } = await getMongoCollections();
  await fivemHierarchyLogs.insertOne({ _id: randomUUID(), createdAt: new Date(), ...input });
}

function toPanelDto(row: MongoFivemHierarchyPanel): FivemHierarchyPanelDto {
  return {
    botId: normalizeBotId(row.botId),
    color: row.color,
    createdAt: row.createdAt.toISOString(),
    description: row.description ?? null,
    displayMode: normalizeDisplayMode(row.displayMode),
    emptyText: row.emptyText ?? "Nenhum membro",
    enabled: row.enabled === true,
    editorRoleIds: row.editorRoleIds ?? [],
    footerEnabled: row.footerEnabled !== false,
    footerIconUrl: row.footerIconUrl ?? null,
    footerScope: row.footerScope === "global" || row.useGlobalFooter ? "global" : "unit",
    footerText: row.footerText ?? null,
    globalFooterIconUrl: row.globalFooterIconUrl ?? null,
    globalFooterText: row.globalFooterText ?? "NPD - North Police Department",
    guildId: row.guildId,
    hierarchies: (row.hierarchies ?? []).map((item) => ({
      ...item,
      emptyText: item.emptyText ?? null,
      showWhenEmpty: item.showWhenEmpty !== false
    })),
    id: row._id,
    imagePosition: row.imagePosition ?? "none",
    imageUrl: row.imageUrl ?? null,
    linkedToFivem: row.linkedToFivem !== false,
    name: row.name,
    panelChannelId: row.panelChannelId ?? null,
    panelMessageId: row.panelMessageId ?? null,
    title: row.title,
    unitId: row.unitId ?? "custom",
    useGlobalFooter: row.useGlobalFooter === true || row.footerScope === "global",
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ?? null
  };
}

function toLogDto(row: MongoFivemHierarchyLog): FivemHierarchyLogDto {
  return { action: row.action, botId: normalizeBotId(row.botId), createdAt: row.createdAt.toISOString(), details: row.details ?? {}, guildId: row.guildId, id: row._id, panelId: row.panelId ?? null, userId: row.userId ?? null };
}

function scopeQuery(guildId: string, botId: string | null) {
  return botId ? { botId, guildId } : { guildId, $or: [{ botId: null }, { botId: { $exists: false } }] };
}

function normalizeBotId(botId: string | null | undefined) {
  const normalized = botId?.trim();
  return normalized ? normalized : null;
}

function normalizeSnowflake(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return /^\d{5,32}$/.test(normalized) ? normalized : null;
}

function normalizeText(value: string | null | undefined, maxLength: number) {
  const normalized = value?.trim().slice(0, maxLength) ?? "";
  return normalized || null;
}

function normalizeDisplayMode(value: unknown): FivemHierarchyPanelDto["displayMode"] {
  return value === "display_name" || value === "nickname" || value === "name_with_id" ? value : "mention";
}

function slugId(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || randomUUID();
}
