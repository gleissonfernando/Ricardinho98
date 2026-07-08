import { Router } from "express";
import { z } from "zod";
import { requireBot } from "../middleware/auth";
import { devBotRealtimeRoom, emitRealtimeToRoom } from "../realtime/events";
import { authorizeBotCommand } from "../services/botCommandAuthorizationService";
import { authorizeBotRuntimeModule, getBotGuildConfig, getBotApiPermissions, updateBotGuildModuleConfig, updateBotGuildModuleRuntimeStatus } from "../services/devBotService";
import { getMaintenanceState } from "../services/maintenanceService";
import { getOperationalNoticeState } from "../services/operationalNoticeService";
import { resolveRequestBotId } from "../services/requestBotScopeService";

export const botDevApiRouter = Router();
const commandAuthorizationSchema = z.object({
  channelId: z.string().nullable().optional(),
  userId: z.string().nullable().optional()
});
const guildIdSchema = z.string().regex(/^\d{5,32}$/);
const moduleIdSchema = z.string().regex(/^[a-z0-9_-]{1,80}$/);
const primitiveConfigValue = z.union([z.boolean(), z.string().max(500), z.number().finite().min(0).max(1_000_000), z.null()]);
const moduleConfigSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  z.union([primitiveConfigValue, z.array(primitiveConfigValue).max(250)])
).default({});
const tagVerificationStatusSchema = z.object({
  lastCheckAt: z.string().datetime(),
  nextCheckAt: z.string().datetime().nullable(),
  totalChecked: z.number().int().min(0),
  totalAssigned: z.number().int().min(0),
  totalRemoved: z.number().int().min(0),
  totalIgnored: z.number().int().min(0),
  totalUnavailable: z.number().int().min(0),
  totalErrors: z.number().int().min(0),
  lastError: z.string().max(500).nullable()
});
const policeReportsPanelStateSchema = z.object({
  messageId: z.string().regex(/^\d{5,32}$/).nullable()
});
const policeRhPanelStateSchema = z.object({
  messageId: z.string().regex(/^\d{5,32}$/).nullable()
});
const snowflake = z.string().regex(/^\d{5,32}$/);
const policeRhRuntimeConfigSchema = z.object({
  absenceApproverRoleIds: z.array(snowflake).max(100).optional(),
  absenceLogChannelId: snowflake.nullable().optional(),
  absencePanelChannelId: snowflake.nullable().optional(),
  pendingAbsenceRemovals: z.array(z.object({
    absenceRoleId: snowflake,
    approvedAt: z.string().datetime(),
    approvedBy: snowflake.nullable(),
    returnDate: z.string().max(40),
    returnDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    userId: snowflake
  })).max(500).optional(),
  absenceRoleId: snowflake.nullable().optional(),
  adornoLogChannelId: snowflake.nullable().optional(),
  adornoPanelChannelId: snowflake.nullable().optional(),
  enabled: z.boolean().optional(),
  panelChannelId: snowflake.nullable().optional(),
  rhLogChannelId: snowflake.nullable().optional(),
  rhPanelChannelId: snowflake.nullable().optional()
});
const policeFlightStateSchema = z.object({
  panelMessageId: z.string().regex(/^\d{5,32}$/).nullable().optional(),
  panelMessageChannelId: z.string().regex(/^\d{5,32}$/).nullable().optional(),
  panelChannelId: z.string().regex(/^\d{5,32}$/).nullable().optional(),
  panelChannelIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  logChannelId: z.string().regex(/^\d{5,32}$/).nullable().optional(),
  logChannelIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  categoryId: z.string().regex(/^\d{5,32}$/).nullable().optional(),
  categoryIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  allowedRoleIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  dafRoleIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  pilotRoleIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  shooterRoleIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  closeRoleIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  adminRoleIds: z.array(z.string().regex(/^\d{5,32}$/)).max(100).optional(),
  titleText: z.string().trim().min(1).max(120).optional(),
  descriptionText: z.string().trim().max(1200).optional(),
  panelFooter: z.string().trim().max(200).optional(),
  panelImage: z.string().trim().max(500).nullable().optional(),
  allowSameUserBothFunctions: z.boolean().optional(),
  allowReplaceOccupiedRole: z.boolean().optional(),
  scaleId: z.coerce.number().int().min(1).max(1_000_000).optional(),
  status: z.enum(["open", "closed"]).optional(),
  openedBy: z.string().regex(/^\d{5,32}$/).nullable().optional(),
  openedAt: z.string().datetime().nullable().optional(),
  closedBy: z.string().regex(/^\d{5,32}$/).nullable().optional(),
  closedAt: z.string().datetime().nullable().optional(),
  pilotIds: z.array(z.string().regex(/^\d{5,32}$/)).max(5).optional(),
  shooterIds: z.array(z.string().regex(/^\d{5,32}$/)).max(5).optional()
});

botDevApiRouter.use(requireBot);

botDevApiRouter.get("/maintenance", async (_req, res, next) => {
  try {
    return res.json({
      maintenance: await getMaintenanceState()
    });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.get("/operational-notice", async (_req, res, next) => {
  try {
    return res.json({
      notice: await getOperationalNoticeState()
    });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.get("/runtime/modules", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const permissions = botId ? await getBotApiPermissions(botId) : null;

    if (!permissions) {
      return res.status(404).json({
        error: "Bot nao encontrado."
      });
    }

    return res.json({
      active: permissions.status !== "error" && permissions.status !== "invalid_token",
      botId,
      checkedAt: new Date().toISOString(),
      enabledModules: permissions.enabledModules,
      status: permissions.status
    });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.get("/runtime/guilds/:guildId/modules/:moduleId/authorize", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const authorization = await authorizeBotRuntimeModule({
      botId,
      guildId: req.params.guildId,
      moduleId: req.params.moduleId
    });

    return res.json({
      authorization
    });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.post("/runtime/guilds/:guildId/tag-verification/status", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const status = tagVerificationStatusSchema.parse(req.body ?? {});
    const authorization = await authorizeBotRuntimeModule({ botId, guildId, moduleId: "tag-verification" });

    if (!authorization.allowed || !botId) {
      return res.status(403).json({ message: authorization.reason });
    }

    await updateBotGuildModuleRuntimeStatus({ botId, guildId, moduleId: "tag-verification", status });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.post("/runtime/guilds/:guildId/police-reports/panel-state", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const input = policeReportsPanelStateSchema.parse(req.body ?? {});
    const authorization = await authorizeBotRuntimeModule({ botId, guildId, moduleId: "police-reports" });
    if (!authorization.allowed || !botId) return res.status(403).json({ message: authorization.reason });
    const current = await getBotGuildConfig(botId, guildId);
    const modules = current.modules as Record<string, Record<string, unknown>>;
    const currentConfig = modules["police-reports"] ?? {};
    const module = await updateBotGuildModuleConfig({
      botId,
      guildId,
      guildName: current.guildName,
      moduleId: "police-reports",
      config: { ...currentConfig, panelMessageId: input.messageId }
    });
    return res.json({ module });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.post("/runtime/guilds/:guildId/police-rh/panel-state", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const input = policeRhPanelStateSchema.parse(req.body ?? {});
    const authorization = await authorizeBotRuntimeModule({ botId, guildId, moduleId: "police-rh" });
    if (!authorization.allowed || !botId) return res.status(403).json({ message: authorization.reason });
    const current = await getBotGuildConfig(botId, guildId);
    const modules = current.modules as Record<string, Record<string, unknown>>;
    const currentConfig = modules["police-rh"] ?? {};
    const module = await updateBotGuildModuleConfig({
      botId,
      guildId,
      guildName: current.guildName,
      moduleId: "police-rh",
      config: { ...currentConfig, panelMessageId: input.messageId }
    });
    return res.json({ module });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.post("/runtime/guilds/:guildId/police-rh/config", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const input = policeRhRuntimeConfigSchema.parse(req.body ?? {});
    const authorization = await authorizeBotRuntimeModule({ botId, guildId, moduleId: "police-rh" });
    if (!authorization.allowed || !botId) return res.status(403).json({ message: authorization.reason });
    const current = await getBotGuildConfig(botId, guildId);
    const modules = current.modules as Record<string, Record<string, unknown>>;
    const currentConfig = modules["police-rh"] ?? {};
    const nextConfig = {
      ...currentConfig,
      ...input,
      ...(input.panelChannelId ? { rhPanelChannelId: input.rhPanelChannelId ?? input.panelChannelId } : {}),
      ...(input.absencePanelChannelId ? { panelChannelId: currentConfig.panelChannelId ?? input.absencePanelChannelId } : {}),
      ...(input.adornoPanelChannelId ? { panelChannelId: currentConfig.panelChannelId ?? input.adornoPanelChannelId } : {})
    };
    const module = await updateBotGuildModuleConfig({
      botId,
      guildId,
      guildName: current.guildName,
      moduleId: "police-rh",
      config: nextConfig
    });
    emitRealtimeToRoom(devBotRealtimeRoom(botId), "police-rh:panel_update", { action: "update", botId, guildId });
    return res.json({ module });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.post("/runtime/guilds/:guildId/police-rh/publish", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const authorization = await authorizeBotRuntimeModule({ botId, guildId, moduleId: "police-rh" });
    if (!authorization.allowed || !botId) return res.status(403).json({ message: authorization.reason });
    emitRealtimeToRoom(devBotRealtimeRoom(botId), "police-rh:panel_update", { action: "publish", botId, guildId });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.post("/runtime/guilds/:guildId/police-flight/state", async (req, res, next) => {
  try {
    const botId = await resolveRequestBotId(req);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const input = policeFlightStateSchema.parse(req.body ?? {});
    const authorization = await authorizeBotRuntimeModule({ botId, guildId, moduleId: "police-flight" });
    if (!authorization.allowed || !botId) return res.status(403).json({ message: authorization.reason });
    const current = await getBotGuildConfig(botId, guildId);
    const modules = current.modules as Record<string, Record<string, unknown>>;
    const currentConfig = modules["police-flight"] ?? {};
    const module = await updateBotGuildModuleConfig({
      botId,
      guildId,
      guildName: current.guildName,
      moduleId: "police-flight",
      config: { ...currentConfig, ...input }
    });
    return res.json({ module });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.post("/guilds/:guildId/commands/:commandName/authorize", async (req, res, next) => {
  try {
    const { commandName, guildId } = req.params;
    const input = commandAuthorizationSchema.parse(req.body ?? {});

    if (!commandName || !guildId) {
      return res.status(400).json({
        message: "guildId e commandName sao obrigatorios."
      });
    }

    const authorization = await authorizeBotCommand({
      botId: await resolveRequestBotId(req),
      channelId: input.channelId,
      commandName,
      guildId,
      userId: input.userId
    });

    return res.json({
      authorization
    });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.get("/:botId/permissions", async (req, res, next) => {
  try {
    const permissions = await getBotApiPermissions(req.params.botId);

    if (!permissions) {
      return res.status(404).json({
        error: "Bot nao encontrado."
      });
    }

    return res.json(permissions);
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.get("/:botId/guild/:guildId/modules", async (req, res, next) => {
  try {
    const permissions = await getBotApiPermissions(req.params.botId);

    if (!permissions) {
      return res.status(404).json({
        error: "Bot nao encontrado."
      });
    }

    return res.json({
      botId: req.params.botId,
      guildId: req.params.guildId,
      modules: permissions.enabledModules
    });
  } catch (error) {
    return next(error);
  }
});

botDevApiRouter.get("/:botId/guild/:guildId/config", async (req, res, next) => {
  try {
    const permissions = await getBotApiPermissions(req.params.botId);

    if (!permissions) {
      return res.status(404).json({
        error: "Bot nao encontrado."
      });
    }

    const config = await getBotGuildConfig(req.params.botId, req.params.guildId);

    return res.json({
      ...config,
      enabledModules: permissions.enabledModules
    });
  } catch (error) {
    return next(error);
  }
});
