import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireBot } from "../middleware/auth";
import { canReadDevBotModule, canUseDevBotModule, getBotApiPermissions } from "../services/devBotService";
import { getOpenPointCounter, getOpenPointSettings, incrementOpenPointCounter, markOpenPointFineGenerated, resetOpenPointCounter, saveOpenPointSettings } from "../services/openPointNotificationService";
import { resolveRequestBotId } from "../services/requestBotScopeService";

export const OPEN_POINT_MODULE_ID = "open-point-notification";
export const openPointNotificationsRouter = Router();

const snowflake = z.string().regex(/^\d{5,32}$/);
const settingsSchema = z.object({
  allowedRoleIds: z.array(snowflake).max(50).optional(),
  dmBannerUrl: z.string().max(2048).nullable().optional(),
  enabled: z.boolean().optional(),
  fineBannerUrl: z.string().max(2048).nullable().optional(),
  fineChannelId: snowflake.nullable().optional(),
  fineMode: z.enum(["once_at_3", "every_after_3"]).optional(),
  fineRoleId: snowflake.nullable().optional(),
  justificationChannelId: snowflake.nullable().optional(),
  logChannelId: snowflake.nullable().optional()
});

openPointNotificationsRouter.get("/:guildId/settings", requireAuth, dashboardRoute(false, async (botId, guildId) => ({ settings: await getOpenPointSettings(botId, guildId) })));
openPointNotificationsRouter.patch("/:guildId/settings", requireAuth, dashboardRoute(true, async (botId, guildId, req, userId) => ({ settings: await saveOpenPointSettings(botId, guildId, settingsSchema.parse(req.body), userId) })));

openPointNotificationsRouter.get("/bot/:guildId/settings", requireBot, async (req, res, next) => {
  try {
    const botId = await botIdFor(req);
    await licensed(botId);
    res.json({ settings: await getOpenPointSettings(botId, snowflake.parse(req.params.guildId)) });
  } catch (error) { next(error); }
});

openPointNotificationsRouter.patch("/bot/:guildId/settings", requireBot, async (req, res, next) => {
  try {
    const botId = await botIdFor(req);
    await licensed(botId);
    res.json({ settings: await saveOpenPointSettings(botId, snowflake.parse(req.params.guildId), settingsSchema.parse(req.body), null) });
  } catch (error) { next(error); }
});

openPointNotificationsRouter.post("/bot/:guildId/notify", requireBot, async (req, res, next) => {
  try {
    const botId = await botIdFor(req);
    await licensed(botId);
    const input = z.object({ appliedBy: snowflake, userId: snowflake }).parse(req.body);
    res.status(201).json({ counter: await incrementOpenPointCounter({ botId, guildId: snowflake.parse(req.params.guildId), ...input }) });
  } catch (error) { next(error); }
});

openPointNotificationsRouter.get("/bot/:guildId/counters/:userId", requireBot, async (req, res, next) => {
  try {
    const botId = await botIdFor(req);
    await licensed(botId);
    res.json({ counter: await getOpenPointCounter(botId, snowflake.parse(req.params.guildId), snowflake.parse(req.params.userId)) });
  } catch (error) { next(error); }
});

openPointNotificationsRouter.post("/bot/:guildId/counters/:userId/reset", requireBot, async (req, res, next) => {
  try {
    const botId = await botIdFor(req);
    await licensed(botId);
    const input = z.object({ resetBy: snowflake }).parse(req.body);
    res.json({ counter: await resetOpenPointCounter({ botId, guildId: snowflake.parse(req.params.guildId), resetBy: input.resetBy, userId: snowflake.parse(req.params.userId) }) });
  } catch (error) { next(error); }
});

openPointNotificationsRouter.post("/bot/:guildId/counters/:userId/fine-generated", requireBot, async (req, res, next) => {
  try {
    const botId = await botIdFor(req);
    await licensed(botId);
    res.json({ counter: await markOpenPointFineGenerated(botId, snowflake.parse(req.params.guildId), snowflake.parse(req.params.userId)) });
  } catch (error) { next(error); }
});

function dashboardRoute(manage: boolean, handler: (botId: string, guildId: string, req: any, userId: string) => Promise<unknown>) {
  return async (req: any, res: any, next: any) => {
    try {
      const botId = await botIdFor(req);
      const guildId = snowflake.parse(req.params.guildId);
      const user = res.locals.dashboardAuth.user;
      await licensed(botId);
      const allowed = manage ? await canUseDevBotModule(user, botId, guildId, OPEN_POINT_MODULE_ID) : await canReadDevBotModule(user, botId, guildId, OPEN_POINT_MODULE_ID);
      if (!allowed) throw routeError("Sem permissão para este módulo.", 403);
      res.json(await handler(botId, guildId, req, user.discordId));
    } catch (error) { next(error); }
  };
}

async function botIdFor(req: any) {
  const id = await resolveRequestBotId(req);
  if (!id) throw routeError("Bot não identificado.", 400);
  return id;
}
async function licensed(botId: string) {
  const value = await getBotApiPermissions(botId);
  if (!value) throw routeError("Bot não encontrado.", 404);
  if (!value.enabledModules.includes(OPEN_POINT_MODULE_ID)) throw routeError("Módulo não liberado.", 403);
}
function routeError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }
