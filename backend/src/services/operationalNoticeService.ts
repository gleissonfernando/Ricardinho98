import { randomUUID } from "node:crypto";
import { getMongoCollections, type MongoOperationalNoticeLog, type MongoOperationalNoticeState } from "../database/mongo";
import { emitRealtime, emitRealtimeToRoom, botRealtimeRoom } from "../realtime/events";

export type OperationalNoticeAction = "enabled" | "disabled" | "manual_alert" | "updated";

export type OperationalNoticeLogDto = {
  id: string;
  action: OperationalNoticeAction;
  active: boolean;
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
  message: string;
};

export type OperationalNoticeStateDto = {
  active: boolean;
  activatedAt: string | null;
  affectedBots: number;
  deactivatedAt: string | null;
  logs: OperationalNoticeLogDto[];
  message: string;
  updatedAt: string;
  updatedById: string | null;
  updatedByName: string | null;
};

const STATE_ID = "global";
export const DEFAULT_OPERATIONAL_NOTICE_MESSAGE = "Orviteck informa: os bots ficarão offline por 3 dias por troca de hospedagem.";

let memoryState: OperationalNoticeStateDto = {
  active: false,
  activatedAt: null,
  affectedBots: 0,
  deactivatedAt: null,
  logs: [],
  message: DEFAULT_OPERATIONAL_NOTICE_MESSAGE,
  updatedAt: new Date(0).toISOString(),
  updatedById: null,
  updatedByName: null
};

export async function getOperationalNoticeState(): Promise<OperationalNoticeStateDto> {
  const [state, logs, affectedBots] = await Promise.all([
    readPersistedState(),
    listOperationalNoticeLogs(),
    countDevBots()
  ]);

  return {
    ...state,
    affectedBots,
    logs
  };
}

export async function setOperationalNotice(input: {
  active: boolean;
  actorId?: string | null;
  actorName?: string | null;
  message?: string | null;
}) {
  const current = await getOperationalNoticeState();
  const now = new Date();
  const actorId = input.actorId ?? null;
  const actorName = input.actorName ?? null;
  const message = normalizeMessage(input.message ?? current.message);
  const next: OperationalNoticeStateDto = {
    ...current,
    active: input.active,
    activatedAt: input.active ? current.activatedAt ?? now.toISOString() : current.activatedAt,
    deactivatedAt: input.active ? null : now.toISOString(),
    message,
    updatedAt: now.toISOString(),
    updatedById: actorId,
    updatedByName: actorName
  };
  const action: OperationalNoticeAction = input.active ? "enabled" : "disabled";

  await persistState(next);
  await appendOperationalNoticeLog({
    action,
    active: next.active,
    actorId,
    actorName,
    message: input.active ? "Aviso operacional dos bots ativado." : "Aviso operacional dos bots desativado."
  });

  const dto = await getOperationalNoticeState();
  emitOperationalNoticeUpdate(dto, input.active ? "operational-notice:started" : "operational-notice:ended");
  return dto;
}

export async function updateOperationalNoticeMessage(input: {
  actorId?: string | null;
  actorName?: string | null;
  message: string;
}) {
  const current = await getOperationalNoticeState();
  const now = new Date();
  const next: OperationalNoticeStateDto = {
    ...current,
    message: normalizeMessage(input.message),
    updatedAt: now.toISOString(),
    updatedById: input.actorId ?? null,
    updatedByName: input.actorName ?? null
  };

  await persistState(next);
  await appendOperationalNoticeLog({
    action: "updated",
    active: next.active,
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
    message: "Texto do aviso operacional atualizado."
  });

  const dto = await getOperationalNoticeState();
  emitOperationalNoticeUpdate(dto, next.active ? "operational-notice:updated" : "operational-notice:configured");
  return dto;
}

export async function sendOperationalNoticeManualAlert(input: {
  actorId?: string | null;
  actorName?: string | null;
}) {
  const state = await getOperationalNoticeState();

  await appendOperationalNoticeLog({
    action: "manual_alert",
    active: state.active,
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
    message: "Aviso operacional reenviado manualmente."
  });

  const dto = await getOperationalNoticeState();
  emitOperationalNoticeUpdate(dto, "operational-notice:manual_alert");
  return dto;
}

function emitOperationalNoticeUpdate(state: OperationalNoticeStateDto, action: string) {
  const payload = { action, state };
  emitRealtime("operational-notice:updated", payload);
  emitRealtimeToRoom(botRealtimeRoom(), "operational-notice:updated", payload);
}

async function readPersistedState(): Promise<Omit<OperationalNoticeStateDto, "affectedBots" | "logs">> {
  try {
    const { operationalNoticeState } = await getMongoCollections();
    const doc = await operationalNoticeState.findOne({ _id: STATE_ID });

    if (!doc) {
      return {
        active: false,
        activatedAt: null,
        deactivatedAt: null,
        message: DEFAULT_OPERATIONAL_NOTICE_MESSAGE,
        updatedAt: new Date(0).toISOString(),
        updatedById: null,
        updatedByName: null
      };
    }

    return toStateDto(doc);
  } catch (error) {
    console.warn("[operational-notice] usando estado em memória:", error instanceof Error ? error.message : error);
    return memoryState;
  }
}

async function persistState(state: OperationalNoticeStateDto) {
  memoryState = state;

  try {
    const { operationalNoticeState } = await getMongoCollections();
    await operationalNoticeState.updateOne(
      { _id: STATE_ID },
      {
        $set: {
          active: state.active,
          activatedAt: state.activatedAt ? new Date(state.activatedAt) : null,
          deactivatedAt: state.deactivatedAt ? new Date(state.deactivatedAt) : null,
          message: state.message,
          updatedAt: new Date(state.updatedAt),
          updatedById: state.updatedById,
          updatedByName: state.updatedByName
        }
      },
      { upsert: true }
    );
  } catch (error) {
    console.warn("[operational-notice] estado mantido em memória:", error instanceof Error ? error.message : error);
  }
}

async function appendOperationalNoticeLog(input: Omit<OperationalNoticeLogDto, "id" | "createdAt">) {
  const log: OperationalNoticeLogDto = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  };

  memoryState = {
    ...memoryState,
    logs: [log, ...memoryState.logs].slice(0, 25)
  };

  try {
    const { operationalNoticeLogs } = await getMongoCollections();
    const doc: MongoOperationalNoticeLog = {
      _id: log.id,
      action: log.action,
      active: log.active,
      actorId: log.actorId,
      actorName: log.actorName,
      createdAt: new Date(log.createdAt),
      message: log.message
    };

    await operationalNoticeLogs.insertOne(doc);
  } catch (error) {
    console.warn("[operational-notice] log mantido em memória:", error instanceof Error ? error.message : error);
  }
}

async function listOperationalNoticeLogs() {
  try {
    const { operationalNoticeLogs } = await getMongoCollections();
    const docs = await operationalNoticeLogs.find({}).sort({ createdAt: -1 }).limit(25).toArray();
    return docs.map(toLogDto);
  } catch {
    return memoryState.logs;
  }
}

async function countDevBots() {
  try {
    const { devBots } = await getMongoCollections();
    return await devBots.countDocuments({});
  } catch {
    return 0;
  }
}

function normalizeMessage(value: string) {
  const trimmed = value.trim();
  return trimmed.slice(0, 1200) || DEFAULT_OPERATIONAL_NOTICE_MESSAGE;
}

function toStateDto(doc: MongoOperationalNoticeState): Omit<OperationalNoticeStateDto, "affectedBots" | "logs"> {
  return {
    active: doc.active,
    activatedAt: doc.activatedAt?.toISOString() ?? null,
    deactivatedAt: doc.deactivatedAt?.toISOString() ?? null,
    message: doc.message || DEFAULT_OPERATIONAL_NOTICE_MESSAGE,
    updatedAt: doc.updatedAt.toISOString(),
    updatedById: doc.updatedById ?? null,
    updatedByName: doc.updatedByName ?? null
  };
}

function toLogDto(doc: MongoOperationalNoticeLog): OperationalNoticeLogDto {
  return {
    id: doc._id,
    action: doc.action,
    active: doc.active,
    actorId: doc.actorId,
    actorName: doc.actorName,
    createdAt: doc.createdAt.toISOString(),
    message: doc.message
  };
}
