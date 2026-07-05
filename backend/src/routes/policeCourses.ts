import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { raw, Router } from "express";
import { z } from "zod";
import { requireAuth, requireBot } from "../middleware/auth";
import { canReadDevBotModule, canUseDevBotModule, getBotApiPermissions } from "../services/devBotService";
import {
  closePoliceCourse, createPoliceCourse, deletePoliceCourse, getPoliceCourse, getPoliceCourseConfig,
  getPoliceCourseDashboard, joinPoliceCourse, leavePoliceCourse, listPoliceCourses, POLICE_COURSES_MODULE_ID,
  requestPoliceCoursePublish, savePoliceCourseConfig, setPoliceCourseBanner, setPoliceCoursePanel, updatePoliceCourse
} from "../services/policeCourseService";
import { resolveRequestBotId } from "../services/requestBotScopeService";

const snowflake = z.string().regex(/^\d{5,32}$/);
const uuid = z.string().uuid();
const style = z.enum(["primary", "secondary", "success", "danger"]);
const courseSchema = z.object({
  courseNumber: z.string().trim().min(1).max(50),
  title: z.string().trim().min(1).max(100),
  instructorId: snowflake.nullable().optional(),
  instructorName: z.string().trim().max(100).optional(),
  date: z.string().trim().max(50).optional(),
  time: z.string().trim().max(50).optional(),
  location: z.string().trim().max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(1000).optional(),
  maxSlots: z.number().int().min(1).max(500).nullable().optional(),
  bannerUrl: z.string().trim().max(2048).nullable().optional()
});
const configSchema = z.object({
  enabled: z.boolean().optional(),
  logChannelId: snowflake.nullable().optional(),
  defaultCategoryId: snowflake.nullable().optional(),
  defaultPanelChannelId: snowflake.nullable().optional(),
  allowedManagerRoles: z.array(snowflake).max(100).optional(),
  allowedFinishRoles: z.array(snowflake).max(100).optional(),
  dmOnFinish: z.boolean().optional(),
  dmOnCancel: z.boolean().optional(),
  lockChannelOnFinish: z.boolean().optional(),
  lockChannelOnCancel: z.boolean().optional(),
  deletePanelOnCancel: z.boolean().optional(),
  removeDepartedMembers: z.boolean().optional(),
  panelHeader: z.string().trim().min(1).max(200).optional(),
  panelText: z.string().trim().max(1000).optional(),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  joinButtonStyle: style.optional(),
  leaveButtonStyle: style.optional()
});

const upload = raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "8mb" });
const uploadRoot = path.resolve(__dirname, "../../uploads/police-courses");
export const policeCoursesRouter = Router();

policeCoursesRouter.get("/:guildId", requireAuth, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, false);
    res.json(await getPoliceCourseDashboard(scope.botId, scope.guildId));
  } catch (error) { next(error); }
});
policeCoursesRouter.patch("/:guildId/config", requireAuth, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, true);
    res.json({ config: await savePoliceCourseConfig(scope.botId, scope.guildId, configSchema.parse(req.body), res.locals.dashboardAuth.user.discordId) });
  } catch (error) { next(error); }
});
policeCoursesRouter.post("/:guildId/courses", requireAuth, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, true);
    res.status(201).json({ course: await createPoliceCourse(scope.botId, scope.guildId, courseSchema.parse(req.body), res.locals.dashboardAuth.user.discordId) });
  } catch (error) { next(error); }
});
policeCoursesRouter.patch("/:guildId/courses/:courseId", requireAuth, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, true);
    res.json({ course: await updatePoliceCourse(scope.botId, scope.guildId, uuid.parse(req.params.courseId), courseSchema.partial().parse(req.body), res.locals.dashboardAuth.user.discordId) });
  } catch (error) { next(error); }
});
policeCoursesRouter.delete("/:guildId/courses/:courseId", requireAuth, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, true);
    res.json({ course: await deletePoliceCourse(scope.botId, scope.guildId, uuid.parse(req.params.courseId), res.locals.dashboardAuth.user.discordId) });
  } catch (error) { next(error); }
});
policeCoursesRouter.post("/:guildId/courses/:courseId/publish", requireAuth, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, true);
    const input = z.object({ channelId: snowflake.nullable().optional() }).parse(req.body ?? {});
    await getPoliceCourse(scope.botId, scope.guildId, uuid.parse(req.params.courseId));
    requestPoliceCoursePublish(scope.botId, scope.guildId, req.params.courseId!, input.channelId);
    res.status(202).json({ ok: true });
  } catch (error) { next(error); }
});
policeCoursesRouter.put("/:guildId/courses/:courseId/banner", requireAuth, upload, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, true);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw routeError("Imagem vazia.", 400);
    const contentType = req.header("content-type") ?? "";
    const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    await mkdir(uploadRoot, { recursive: true });
    const filename = `${scope.botId}-${scope.guildId}-${uuid.parse(req.params.courseId)}-${Date.now()}.${extension}`;
    await writeFile(path.join(uploadRoot, filename), req.body);
    const publicPath = `/uploads/police-courses/${filename}`;
    const bannerUrl = publicPath;
    res.json({ course: await setPoliceCourseBanner(scope.botId, scope.guildId, req.params.courseId!, bannerUrl, res.locals.dashboardAuth.user.discordId) });
  } catch (error) { next(error); }
});
policeCoursesRouter.delete("/:guildId/courses/:courseId/banner", requireAuth, async (req, res, next) => {
  try {
    const scope = await dashboardScope(req, res, true);
    const course = await getPoliceCourse(scope.botId, scope.guildId, uuid.parse(req.params.courseId));
    const localName = typeof course.bannerUrl === "string" ? course.bannerUrl.split("/uploads/police-courses/")[1] : null;
    if (localName && !localName.includes("/") && !localName.includes("\\")) await unlink(path.join(uploadRoot, localName)).catch(() => undefined);
    res.json({ course: await setPoliceCourseBanner(scope.botId, scope.guildId, req.params.courseId!, null, res.locals.dashboardAuth.user.discordId) });
  } catch (error) { next(error); }
});

policeCoursesRouter.get("/bot/:guildId/config", requireBot, async (req, res, next) => {
  try { const scope = await botScope(req); res.json({ config: await getPoliceCourseConfig(scope.botId, scope.guildId) }); } catch (error) { next(error); }
});
policeCoursesRouter.patch("/bot/:guildId/config", requireBot, async (req, res, next) => {
  try { const scope = await botScope(req); res.json({ config: await savePoliceCourseConfig(scope.botId, scope.guildId, configSchema.parse(req.body), req.body?.actorId ?? null) }); } catch (error) { next(error); }
});
policeCoursesRouter.get("/bot/:guildId/courses", requireBot, async (req, res, next) => {
  try { const scope = await botScope(req); res.json({ courses: await listPoliceCourses(scope.botId, scope.guildId) }); } catch (error) { next(error); }
});
policeCoursesRouter.get("/bot/:guildId/courses/:courseId", requireBot, async (req, res, next) => {
  try { const scope = await botScope(req); res.json({ course: await getPoliceCourse(scope.botId, scope.guildId, uuid.parse(req.params.courseId)) }); } catch (error) { next(error); }
});
policeCoursesRouter.post("/bot/:guildId/courses", requireBot, async (req, res, next) => {
  try { const scope = await botScope(req); res.status(201).json({ course: await createPoliceCourse(scope.botId, scope.guildId, courseSchema.parse(req.body), req.body?.actorId ?? null) }); } catch (error) { next(error); }
});
policeCoursesRouter.patch("/bot/:guildId/courses/:courseId", requireBot, async (req, res, next) => {
  try { const scope = await botScope(req); res.json({ course: await updatePoliceCourse(scope.botId, scope.guildId, uuid.parse(req.params.courseId), courseSchema.partial().parse(req.body), req.body?.actorId ?? null) }); } catch (error) { next(error); }
});
policeCoursesRouter.post("/bot/:guildId/courses/:courseId/join", requireBot, async (req, res, next) => {
  try {
    const scope = await botScope(req);
    const input = z.object({ userId: snowflake, guildNickname: z.string().max(100).nullable(), username: z.string().max(100), passportId: z.string().max(50).nullable().optional() }).parse(req.body);
    res.json({ course: await joinPoliceCourse(scope.botId, scope.guildId, req.params.courseId!, { ...input, passportId: input.passportId ?? null, joinedAt: new Date() }) });
  } catch (error) { next(error); }
});
policeCoursesRouter.post("/bot/:guildId/courses/:courseId/leave", requireBot, async (req, res, next) => {
  try { const scope = await botScope(req); res.json({ course: await leavePoliceCourse(scope.botId, scope.guildId, req.params.courseId!, snowflake.parse(req.body?.userId)) }); } catch (error) { next(error); }
});
policeCoursesRouter.post("/bot/:guildId/courses/:courseId/close", requireBot, async (req, res, next) => {
  try {
    const scope = await botScope(req);
    const input = z.object({ actorId: snowflake, status: z.enum(["finished", "canceled"]) }).parse(req.body);
    res.json({ course: await closePoliceCourse(scope.botId, scope.guildId, req.params.courseId!, input.status, input.actorId) });
  } catch (error) { next(error); }
});
policeCoursesRouter.patch("/bot/:guildId/courses/:courseId/panel", requireBot, async (req, res, next) => {
  try {
    const scope = await botScope(req);
    const input = z.object({ panelChannelId: snowflake, panelMessageId: snowflake, actorId: snowflake.nullable().optional() }).parse(req.body);
    res.json({ course: await setPoliceCoursePanel(scope.botId, scope.guildId, req.params.courseId!, input.panelChannelId, input.panelMessageId, input.actorId ?? null) });
  } catch (error) { next(error); }
});

async function dashboardScope(req: any, res: any, manage: boolean) {
  const guildId = snowflake.parse(req.params.guildId);
  const botId = await requireBotId(req);
  await licensed(botId);
  const allowed = manage
    ? await canUseDevBotModule(res.locals.dashboardAuth.user, botId, guildId, POLICE_COURSES_MODULE_ID)
    : await canReadDevBotModule(res.locals.dashboardAuth.user, botId, guildId, POLICE_COURSES_MODULE_ID);
  if (!allowed) throw routeError("Sem permissao para o sistema de cursos.", 403);
  return { botId, guildId };
}
async function botScope(req: any) {
  const botId = await requireBotId(req); await licensed(botId);
  return { botId, guildId: snowflake.parse(req.params.guildId) };
}
async function requireBotId(req: any) { const value = await resolveRequestBotId(req); if (!value) throw routeError("Bot nao identificado.", 400); return value; }
async function licensed(botId: string) {
  const permissions = await getBotApiPermissions(botId);
  if (!permissions) throw routeError("Bot nao encontrado.", 404);
  if (!permissions.enabledModules.includes(POLICE_COURSES_MODULE_ID)) throw routeError("Sistema de cursos nao liberado.", 403);
}
function routeError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }
