import { randomUUID } from "node:crypto";
import {
  getMongoCollections,
  type MongoPoliceCourse,
  type MongoPoliceCourseConfig,
  type MongoPoliceCourseParticipant
} from "../database/mongo";
import { dashboardLogRealtimeRoom, devBotRealtimeRoom, emitRealtimeToRoom } from "../realtime/events";

export const POLICE_COURSES_MODULE_ID = "police-courses";

const DEFAULT_CONFIG = {
  enabled: true,
  logChannelId: null,
  approvalChannelId: null,
  certificateChannelId: null,
  notificationChannelId: null,
  defaultCategoryId: null,
  defaultPanelChannelId: null,
  generalManagerUserIds: [] as string[],
  allowedManagerRoles: [] as string[],
  allowedFinishRoles: [] as string[],
  createRoleIds: [] as string[],
  editRoleIds: [] as string[],
  deleteRoleIds: [] as string[],
  approveRoleIds: [] as string[],
  cancelRoleIds: [] as string[],
  concludeRoleIds: [] as string[],
  allowJoinAfterStart: false,
  allowLeaveAfterStart: true,
  dmOnFinish: false,
  dmOnCancel: false,
  lockChannelOnFinish: false,
  lockChannelOnCancel: false,
  deletePanelOnCancel: false,
  removeDepartedMembers: false,
  panelHeader: "North Police Department • Sistema de Cursos",
  panelText: "Confira os dados abaixo e use os botoes para gerenciar sua inscricao.",
  accentColor: "#2563eb",
  joinButtonStyle: "success" as const,
  leaveButtonStyle: "secondary" as const
};

export async function getPoliceCourseDashboard(botId: string, guildId: string) {
  const [config, courses, logs] = await Promise.all([
    getPoliceCourseConfig(botId, guildId),
    listPoliceCourses(botId, guildId),
    listPoliceCourseLogs(botId, guildId)
  ]);
  return { config, courses, logs };
}

export async function getPoliceCourseConfig(botId: string, guildId: string) {
  const { policeCourseConfigs } = await getMongoCollections();
  let config = await policeCourseConfigs.findOne({ botId, guildId });
  if (!config) {
    const now = new Date();
    const value: MongoPoliceCourseConfig = {
      _id: randomUUID(), botId, guildId, ...DEFAULT_CONFIG, createdAt: now, updatedAt: now, updatedBy: null
    };
    await policeCourseConfigs.updateOne({ botId, guildId }, { $setOnInsert: value }, { upsert: true });
    config = await policeCourseConfigs.findOne({ botId, guildId }) ?? value;
  }
  return configDto(config);
}

export async function savePoliceCourseConfig(botId: string, guildId: string, patch: Partial<MongoPoliceCourseConfig>, actorId: string | null) {
  await getPoliceCourseConfig(botId, guildId);
  const { policeCourseConfigs } = await getMongoCollections();
  const allowed = pick(patch, [
    "enabled", "logChannelId", "approvalChannelId", "certificateChannelId", "notificationChannelId",
    "defaultCategoryId", "defaultPanelChannelId", "generalManagerUserIds",
    "allowedManagerRoles", "allowedFinishRoles", "createRoleIds", "editRoleIds", "deleteRoleIds",
    "approveRoleIds", "cancelRoleIds", "concludeRoleIds", "allowJoinAfterStart", "allowLeaveAfterStart",
    "dmOnFinish", "dmOnCancel", "lockChannelOnFinish", "lockChannelOnCancel",
    "deletePanelOnCancel", "removeDepartedMembers", "panelHeader", "panelText", "accentColor",
    "joinButtonStyle", "leaveButtonStyle"
  ]);
  const result = await policeCourseConfigs.findOneAndUpdate(
    { botId, guildId },
    { $set: { ...allowed, updatedAt: new Date(), updatedBy: actorId } },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Configuracao de cursos nao encontrada.", 404);
  await audit(botId, guildId, null, "config_updated", actorId, {});
  emitChanged(botId, guildId, null, "config_updated");
  return configDto(result);
}

export async function listPoliceCourses(botId: string, guildId: string) {
  const { policeCourses } = await getMongoCollections();
  return (await policeCourses.find({ botId, guildId }).sort({ displayOrder: 1, createdAt: -1 }).toArray()).map(courseDto);
}

export async function getPoliceCourse(botId: string, guildId: string, courseId: string) {
  const { policeCourses } = await getMongoCollections();
  const course = await policeCourses.findOne({ _id: courseId, botId, guildId });
  if (!course) throw serviceError("Curso nao encontrado.", 404);
  return courseDto(course);
}

export async function createPoliceCourse(botId: string, guildId: string, input: CourseInput, actorId: string | null) {
  const { policeCourses } = await getMongoCollections();
  const now = new Date();
  const course: MongoPoliceCourse = {
    _id: randomUUID(), botId, guildId, ...normalizeCourseInput(input), status: input.status ?? "draft",
    panelChannelId: input.panelChannelId?.trim() || null, panelMessageId: null, participants: [], createdBy: actorId,
    createdAt: now, updatedAt: now, updatedBy: actorId
  };
  try {
    await policeCourses.insertOne(course);
  } catch (error: any) {
    if (error?.code === 11000) throw serviceError("Ja existe um curso com esse numero.", 409);
    throw error;
  }
  await audit(botId, guildId, course._id, "course_created", actorId, { title: course.title, courseNumber: course.courseNumber });
  emitChanged(botId, guildId, course._id, "course_created");
  return courseDto(course);
}

export async function updatePoliceCourse(botId: string, guildId: string, courseId: string, input: Partial<CourseInput>, actorId: string | null) {
  const { policeCourses } = await getMongoCollections();
  const current = await policeCourses.findOne({ _id: courseId, botId, guildId });
  if (!current) throw serviceError("Curso nao encontrado.", 404);
  const patch = normalizeCoursePatch(input);
  const result = await policeCourses.findOneAndUpdate(
    { _id: courseId, botId, guildId },
    { $set: { ...patch, updatedAt: new Date(), updatedBy: actorId } },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Curso nao encontrado.", 404);
  await audit(botId, guildId, courseId, "course_updated", actorId, { fields: Object.keys(patch) });
  if (input.authorizedRoleIds) {
    const before = new Set(current.authorizedRoleIds ?? []);
    const after = new Set(input.authorizedRoleIds);
    for (const roleId of after) if (!before.has(roleId)) await audit(botId, guildId, courseId, "instructor_role_added", actorId, { roleId });
    for (const roleId of before) if (!after.has(roleId)) await audit(botId, guildId, courseId, "instructor_role_removed", actorId, { roleId });
  }
  if (input.authorizedUserIds) {
    const before = new Set(current.authorizedUserIds ?? []);
    const after = new Set(input.authorizedUserIds);
    for (const userId of after) if (!before.has(userId)) await audit(botId, guildId, courseId, "instructor_user_added", actorId, { userId });
    for (const userId of before) if (!after.has(userId)) await audit(botId, guildId, courseId, "instructor_user_removed", actorId, { userId });
  }
  emitChanged(botId, guildId, courseId, "course_updated");
  return courseDto(result);
}

export async function deletePoliceCourse(botId: string, guildId: string, courseId: string, actorId: string | null) {
  const { policeCourses } = await getMongoCollections();
  const result = await policeCourses.findOneAndDelete({ _id: courseId, botId, guildId });
  if (!result) throw serviceError("Curso nao encontrado.", 404);
  await audit(botId, guildId, courseId, "course_deleted", actorId, { title: result.title });
  emitChanged(botId, guildId, courseId, "course_deleted");
  return courseDto(result);
}

export async function setPoliceCourseBanner(botId: string, guildId: string, courseId: string, bannerUrl: string | null, actorId: string | null) {
  const course = await updatePoliceCourse(botId, guildId, courseId, { bannerUrl }, actorId);
  await audit(botId, guildId, courseId, "banner_updated", actorId, { bannerUrl });
  return course;
}

export async function setPoliceCoursePanel(botId: string, guildId: string, courseId: string, panelChannelId: string, panelMessageId: string, actorId: string | null) {
  const { policeCourses } = await getMongoCollections();
  const result = await policeCourses.findOneAndUpdate(
    { _id: courseId, botId, guildId },
    { $set: { panelChannelId, panelMessageId, updatedAt: new Date(), updatedBy: actorId } },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Curso nao encontrado.", 404);
  await audit(botId, guildId, courseId, "course_published", actorId, { panelChannelId, panelMessageId });
  emitRealtimeToRoom(dashboardLogRealtimeRoom(guildId, botId), "police-courses:updated", {
    action: "course_published",
    botId,
    guildId,
    courseId
  });
  return courseDto(result);
}

export async function joinPoliceCourse(botId: string, guildId: string, courseId: string, participant: MongoPoliceCourseParticipant) {
  const { policeCourses } = await getMongoCollections();
  const course = await policeCourses.findOne({ _id: courseId, botId, guildId });
  if (!course) throw serviceError("Curso nao encontrado.", 404);
  if (course.status !== "open" && course.status !== "in_progress") throw serviceError("Este curso nao aceita novas inscricoes.", 409);
  if (course.participants.some((item) => item.userId === participant.userId)) throw serviceError("Voce ja esta inscrito neste curso.", 409);
  if (course.maxSlots && course.participants.length >= course.maxSlots) throw serviceError("Nao ha vagas disponiveis neste curso.", 409);
  const result = await policeCourses.findOneAndUpdate(
    {
      _id: courseId, botId, guildId, status: { $in: ["open", "in_progress"] },
      "participants.userId": { $ne: participant.userId },
      ...(course.maxSlots ? { $expr: { $lt: [{ $size: "$participants" }, course.maxSlots] } } : {})
    },
    { $push: { participants: { ...participant, joinedAt: new Date() } }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Este curso atingiu o limite maximo de participantes.", 409);
  await audit(botId, guildId, courseId, "participant_joined", participant.userId, { username: participant.guildNickname || participant.username });
  emitChanged(botId, guildId, courseId, "participant_joined");
  return courseDto(result);
}

export async function leavePoliceCourse(botId: string, guildId: string, courseId: string, userId: string) {
  const { policeCourses } = await getMongoCollections();
  const result = await policeCourses.findOneAndUpdate(
    { _id: courseId, botId, guildId, status: { $in: ["open", "in_progress"] }, "participants.userId": userId },
    { $pull: { participants: { userId } }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Voce nao esta inscrito ou o curso ja foi encerrado.", 409);
  await audit(botId, guildId, courseId, "participant_left", userId, {});
  emitChanged(botId, guildId, courseId, "participant_left");
  return courseDto(result);
}

export async function closePoliceCourse(botId: string, guildId: string, courseId: string, status: "finished" | "canceled", actorId: string) {
  const { policeCourses } = await getMongoCollections();
  const result = await policeCourses.findOneAndUpdate(
    { _id: courseId, botId, guildId, status: { $in: ["open", "in_progress"] } },
    { $set: { status, updatedAt: new Date(), updatedBy: actorId } },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Este curso ja foi encerrado.", 409);
  await audit(botId, guildId, courseId, status === "finished" ? "course_finished" : "course_canceled", actorId, {});
  emitChanged(botId, guildId, courseId, status);
  return courseDto(result);
}

export async function beginPoliceCourse(botId: string, guildId: string, courseId: string, actorId: string) {
  const { policeCourses } = await getMongoCollections();
  const result = await policeCourses.findOneAndUpdate(
    { _id: courseId, botId, guildId, status: "open" },
    { $set: { status: "in_progress", updatedAt: new Date(), updatedBy: actorId } },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Este curso nao esta aberto para iniciar.", 409);
  await audit(botId, guildId, courseId, "course_begun", actorId, {});
  emitChanged(botId, guildId, courseId, "course_begun");
  return courseDto(result);
}

export async function startPoliceCourse(
  botId: string,
  guildId: string,
  courseId: string,
  input: { instructorId: string; instructorName: string; date?: string; time: string; maxSlots: number; location: string },
  actorId: string
) {
  const { policeCourses } = await getMongoCollections();
  const result = await policeCourses.findOneAndUpdate(
    {
      _id: courseId,
      botId,
      guildId,
      $or: [
        { status: { $in: ["draft", "finished", "canceled"] } },
        { status: "open", participants: { $size: 0 } }
      ]
    },
    {
      $set: {
        instructorId: input.instructorId,
        instructorName: input.instructorName.trim(),
        date: input.date?.trim() || "A definir",
        time: input.time.trim(),
        maxSlots: Math.max(1, Math.min(500, Math.floor(input.maxSlots))),
        location: input.location.trim(),
        status: "open",
        participants: [],
        updatedAt: new Date(),
        updatedBy: actorId
      }
    },
    { returnDocument: "after" }
  );
  if (!result) throw serviceError("Este curso ja possui uma turma ativa.", 409);
  await audit(botId, guildId, courseId, "course_started", actorId, {
    instructorId: input.instructorId,
    panelChannelId: result.panelChannelId
  });
  emitChanged(botId, guildId, courseId, "course_started");
  return courseDto(result);
}

export function requestPoliceCoursePublish(botId: string, guildId: string, courseId: string, channelId?: string | null) {
  emitRealtimeToRoom(devBotRealtimeRoom(botId), "police-courses:panel_update", {
    action: "publish", botId, guildId, courseId, channelId: channelId ?? null
  });
}

async function listPoliceCourseLogs(botId: string, guildId: string) {
  const { policeCourseLogs } = await getMongoCollections();
  return (await policeCourseLogs.find({ botId, guildId }).sort({ createdAt: -1 }).limit(100).toArray())
    .map((value) => ({ ...value, id: value._id, createdAt: value.createdAt.toISOString() }));
}

async function audit(botId: string, guildId: string, courseId: string | null, action: string, actorId: string | null, details: Record<string, unknown>) {
  const { policeCourseLogs } = await getMongoCollections();
  await policeCourseLogs.insertOne({ _id: randomUUID(), botId, guildId, courseId, action, actorId, details, createdAt: new Date() });
}

function emitChanged(botId: string, guildId: string, courseId: string | null, action: string) {
  const payload = { action, botId, guildId, courseId };
  emitRealtimeToRoom(devBotRealtimeRoom(botId), "police-courses:panel_update", payload);
  emitRealtimeToRoom(dashboardLogRealtimeRoom(guildId, botId), "police-courses:updated", payload);
}

type CourseInput = {
  courseNumber: string;
  title: string;
  category?: string | null;
  displayOrder?: number;
  emoji?: string | null;
  color?: string | null;
  instructorId?: string | null;
  instructorName?: string;
  date?: string;
  time?: string;
  location?: string;
  description?: string;
  notes?: string;
  maxSlots?: number | null;
  bannerUrl?: string | null;
  imagePosition?: "top" | "thumbnail" | "bottom" | "none";
  authorizedRoleIds?: string[];
  authorizedUserIds?: string[];
  participantRoleIds?: string[];
  viewerRoleIds?: string[];
  panelChannelId?: string | null;
  status?: "draft" | "open" | "in_progress" | "finished" | "canceled";
};

function normalizeCourseInput(input: CourseInput) {
  return {
    courseNumber: input.courseNumber.trim(),
    title: input.title.trim(),
    category: input.category?.trim() || null,
    displayOrder: Number.isFinite(input.displayOrder) ? Math.max(0, Math.floor(input.displayOrder ?? 0)) : 0,
    emoji: input.emoji?.trim() || null,
    color: /^#[0-9a-f]{6}$/i.test(input.color ?? "") ? input.color ?? null : null,
    instructorId: input.instructorId?.trim() || null,
    instructorName: input.instructorName?.trim() || "A definir",
    date: input.date?.trim() || "A definir",
    time: input.time?.trim() || "A definir",
    location: input.location?.trim() || "A definir",
    description: input.description?.trim() || "",
    notes: input.notes?.trim() || "",
    maxSlots: input.maxSlots && input.maxSlots > 0 ? Math.floor(input.maxSlots) : null,
    bannerUrl: input.bannerUrl?.trim() || null,
    imagePosition: input.imagePosition ?? "top",
    authorizedRoleIds: [...new Set(input.authorizedRoleIds ?? [])],
    authorizedUserIds: [...new Set(input.authorizedUserIds ?? [])],
    participantRoleIds: [...new Set(input.participantRoleIds ?? [])],
    viewerRoleIds: [...new Set(input.viewerRoleIds ?? [])]
  };
}

function normalizeCoursePatch(input: Partial<CourseInput>) {
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    if (key === "maxSlots") value[key] = typeof raw === "number" && raw > 0 ? Math.floor(raw) : null;
    else if (key === "displayOrder") value[key] = Number.isFinite(Number(raw)) ? Math.max(0, Math.floor(Number(raw))) : 0;
    else if (key === "status" && ["draft", "open", "in_progress", "finished", "canceled"].includes(String(raw))) value[key] = raw;
    else if (key === "authorizedRoleIds" || key === "authorizedUserIds" || key === "participantRoleIds" || key === "viewerRoleIds") value[key] = Array.isArray(raw) ? [...new Set(raw.filter((item): item is string => typeof item === "string"))] : [];
    else if (key === "instructorId" || key === "bannerUrl" || key === "panelChannelId" || key === "emoji" || key === "color" || key === "category") value[key] = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    else value[key] = typeof raw === "string" ? raw.trim() : raw;
  }
  return value;
}

function configDto(value: MongoPoliceCourseConfig) {
  return {
    ...value,
    approvalChannelId: value.approvalChannelId ?? null,
    certificateChannelId: value.certificateChannelId ?? null,
    notificationChannelId: value.notificationChannelId ?? null,
    generalManagerUserIds: value.generalManagerUserIds ?? [],
    allowedManagerRoles: value.allowedManagerRoles ?? [],
    allowedFinishRoles: value.allowedFinishRoles ?? [],
    createRoleIds: value.createRoleIds ?? [],
    editRoleIds: value.editRoleIds ?? [],
    deleteRoleIds: value.deleteRoleIds ?? [],
    approveRoleIds: value.approveRoleIds ?? [],
    cancelRoleIds: value.cancelRoleIds ?? [],
    concludeRoleIds: value.concludeRoleIds ?? [],
    allowJoinAfterStart: value.allowJoinAfterStart === true,
    allowLeaveAfterStart: value.allowLeaveAfterStart !== false,
    id: value._id,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString()
  };
}

function courseDto(value: MongoPoliceCourse) {
  return {
    ...value,
    emoji: value.emoji ?? null,
    color: value.color ?? null,
    category: value.category ?? null,
    displayOrder: value.displayOrder ?? 0,
    authorizedRoleIds: value.authorizedRoleIds ?? [],
    authorizedUserIds: value.authorizedUserIds ?? [],
    participantRoleIds: value.participantRoleIds ?? [],
    viewerRoleIds: value.viewerRoleIds ?? [],
    imagePosition: value.imagePosition ?? "top",
    id: value._id,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    participants: value.participants.map((item) => ({ ...item, joinedAt: item.joinedAt.toISOString() }))
  };
}

function pick<T extends object>(value: T, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, (value as any)[key]]));
}

function serviceError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}
