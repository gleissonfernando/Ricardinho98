import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireBot } from "../middleware/auth";
import { canReadDevBotModule, canUseDevBotModule, getBotApiPermissions } from "../services/devBotService";
import {
  createSummons, DM_MODULE_ID, getDmDashboard, getDmSettings, getSummons, getSummonsDashboard,
  getSummonsSettings, recordDm, saveDmSettings, saveSummonsSettings, SUMMONS_MODULE_ID, updateSummons
} from "../services/communicationService";
import { resolveRequestBotId } from "../services/requestBotScopeService";

const snowflake = z.string().regex(/^\d{5,32}$/);
const buttonSchema = z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(80), style: z.enum(["primary", "secondary", "success", "danger", "link"]), url: z.string().url().max(2048).nullable() });
const dmSettingsSchema = z.object({
  enabled: z.boolean().optional(), authorizedRoleIds: z.array(snowflake).max(50).optional(),
  logChannelId: snowflake.nullable().optional(), bannerUrl: z.string().max(2048).nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), defaultTitle: z.string().min(1).max(256).optional(),
  defaultText: z.string().max(4000).optional(), footerText: z.string().max(2048).nullable().optional(),
  buttons: z.array(buttonSchema).max(5).optional()
});
const summonsSettingsSchema = z.object({
  enabled: z.boolean().optional(), categoryId: snowflake.nullable().optional(), temporaryCategoryId: snowflake.nullable().optional(),
  authorizedRoleIds: z.array(snowflake).max(50).optional(), moderatorRoleIds: z.array(snowflake).max(50).optional(),
  logChannelId: snowflake.nullable().optional(), bannerUrl: z.string().max(2048).nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), defaultMessage: z.string().max(3000).optional(),
  deleteDelaySeconds: z.coerce.number().int().min(3).max(86400).optional(), transcriptEnabled: z.boolean().optional()
});

export const communicationRouter = Router();

communicationRouter.get("/dm/:guildId", requireAuth, dashboardRoute(DM_MODULE_ID, false, async (botId, guildId) => getDmDashboard(botId, guildId)));
communicationRouter.patch("/dm/:guildId", requireAuth, dashboardRoute(DM_MODULE_ID, true, async (botId, guildId, req, userId) => ({ settings: await saveDmSettings(botId, guildId, dmSettingsSchema.parse(req.body), userId) })));
communicationRouter.get("/summons/:guildId", requireAuth, dashboardRoute(SUMMONS_MODULE_ID, false, async (botId, guildId) => getSummonsDashboard(botId, guildId)));
communicationRouter.patch("/summons/:guildId", requireAuth, dashboardRoute(SUMMONS_MODULE_ID, true, async (botId, guildId, req, userId) => ({ settings: await saveSummonsSettings(botId, guildId, summonsSettingsSchema.parse(req.body), userId) })));

communicationRouter.get("/bot/dm/:guildId", requireBot, async (req, res, next) => { try { const botId = await botIdFor(req); await licensed(botId, DM_MODULE_ID); res.json({ settings: await getDmSettings(botId, snowflake.parse(req.params.guildId)) }); } catch (error) { next(error); } });
communicationRouter.patch("/bot/dm/:guildId", requireBot, async (req, res, next) => { try { const botId = await botIdFor(req); await licensed(botId, DM_MODULE_ID); res.json({ settings: await saveDmSettings(botId, snowflake.parse(req.params.guildId), dmSettingsSchema.parse(req.body), null) }); } catch (error) { next(error); } });
communicationRouter.post("/bot/dm/log", requireBot, async (req, res, next) => { try {
  const botId = await botIdFor(req); await licensed(botId, DM_MODULE_ID);
  const input = z.object({ guildId: snowflake, senderId: snowflake, targetId: snowflake, title: z.string().max(256), description: z.string().max(4000), button: buttonSchema.nullable(), status: z.enum(["sent", "failed"]), error: z.string().max(1000).nullable().optional() }).parse(req.body);
  res.status(201).json({ log: await recordDm({ botId, ...input }) });
} catch (error) { next(error); } });
communicationRouter.get("/bot/summons/:guildId", requireBot, async (req, res, next) => { try { const botId = await botIdFor(req); await licensed(botId, SUMMONS_MODULE_ID); res.json({ settings: await getSummonsSettings(botId, snowflake.parse(req.params.guildId)) }); } catch (error) { next(error); } });
communicationRouter.patch("/bot/summons/:guildId", requireBot, async (req, res, next) => { try { const botId = await botIdFor(req); await licensed(botId, SUMMONS_MODULE_ID); res.json({ settings: await saveSummonsSettings(botId, snowflake.parse(req.params.guildId), summonsSettingsSchema.parse(req.body), null) }); } catch (error) { next(error); } });
communicationRouter.post("/bot/summons", requireBot, async (req, res, next) => { try {
  const botId = await botIdFor(req); await licensed(botId, SUMMONS_MODULE_ID);
  const input = z.object({ guildId: snowflake, targetId: snowflake, requesterId: snowflake, reason: z.string().min(1).max(1000), notes: z.string().max(2000).nullable().optional() }).parse(req.body);
  res.status(201).json({ summons: await createSummons({ botId, ...input }) });
} catch (error) { next(error); } });
communicationRouter.get("/bot/summons/item/:id", requireBot, async (req, res, next) => { try { const botId = await botIdFor(req); await licensed(botId, SUMMONS_MODULE_ID); const value = await getSummons(botId, req.params.id!); if (!value) throw routeError("Intimação não encontrada.", 404); res.json({ summons: value }); } catch (error) { next(error); } });
communicationRouter.patch("/bot/summons/item/:id", requireBot, async (req, res, next) => { try {
  const botId = await botIdFor(req); await licensed(botId, SUMMONS_MODULE_ID);
  const patch = z.object({ channelId: snowflake.nullable().optional(), panelMessageId: snowflake.nullable().optional(), status: z.enum(["creating", "active", "closing", "closed", "failed"]).optional(), transcript: z.string().max(500000).nullable().optional(), closedAt: z.coerce.date().nullable().optional(), closedBy: snowflake.nullable().optional(), deleteAt: z.coerce.date().nullable().optional() }).parse(req.body);
  res.json({ summons: await updateSummons(botId, req.params.id!, patch) });
} catch (error) { next(error); } });

function dashboardRoute(moduleId: string, manage: boolean, handler: (botId: string, guildId: string, req: any, userId: string) => Promise<unknown>) {
  return async (req: any, res: any, next: any) => { try {
    const botId = await botIdFor(req); const guildId = snowflake.parse(req.params.guildId); const user = res.locals.dashboardAuth.user;
    await licensed(botId, moduleId);
    const allowed = manage ? await canUseDevBotModule(user, botId, guildId, moduleId) : await canReadDevBotModule(user, botId, guildId, moduleId);
    if (!allowed) throw routeError("Sem permissão para este módulo.", 403);
    res.json(await handler(botId, guildId, req, user.discordId));
  } catch (error) { next(error); } };
}
async function botIdFor(req: any) { const id = await resolveRequestBotId(req); if (!id) throw routeError("Bot não identificado.", 400); return id; }
async function licensed(botId: string, moduleId: string) { const value = await getBotApiPermissions(botId); if (!value) throw routeError("Bot não encontrado.", 404); if (!value.enabledModules.includes(moduleId)) throw routeError("Módulo não liberado.", 403); }
function routeError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }
