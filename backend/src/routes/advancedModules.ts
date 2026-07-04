import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { devBotRealtimeRoom, emitRealtimeToRoom, emitRealtimeToRoomWithAck } from "../realtime/events";
import {
  canReadDevBotModule,
  canUseDevBotModule,
  getDevBotToken,
  getBotGuildModuleConfig,
  updateBotGuildModuleConfig
} from "../services/devBotService";
import { validateGuildAssignableRole } from "../services/discordOptionsService";
import { createLog } from "../services/logService";
import type { AuthSessionUser } from "../types/session";

const guildIdSchema = z.string().regex(/^\d{5,32}$/);
const botIdSchema = z.string().min(1).max(120);
const snowflakeSchema = z.string().regex(/^\d{5,32}$/);
const moduleIdSchema = z.enum([
  "anti-abuse",
  "anti-ban",
  "suspicious-servers",
  "global-blacklist",
  "advanced-permissions",
  "invite-cleanup",
  "server-backup",
  "vanity-url-protection",
  "hide-empty-voice",
  "anti-disconnect",
  "auto-unmute",
  "temporary-voice",
  "patrol-reports",
  "tag-verification",
  "bio-url-verification",
  "first-lady",
  "music",
  "police-reports"
]);
const primitiveConfigValue = z.union([
  z.boolean(),
  z.string().max(500),
  z.number().finite().min(0).max(1_000_000),
  z.null()
]);
const configSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  z.union([
    primitiveConfigValue,
    z.array(primitiveConfigValue).max(250)
  ])
).default({});
const saveSchema = z.object({
  config: configSchema,
  guildName: z.string().min(1).max(100).optional()
});
const policeReportTypeSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().default(null),
  emoji: z.string().trim().max(80).nullable().default(null),
  order: z.coerce.number().int().min(0).default(0)
});
const defaultPoliceReportComplaintTypes = [
  { id: "denuncia-oficiais", name: "Denúncia de Oficiais", description: "Relatar conduta inadequada de oficiais.", emoji: "🚔", order: 1 },
  { id: "denuncia-alto-comando", name: "Denúncia de Alto Comando", description: "Relatar ocorrencias envolvendo alto comando.", emoji: "👮", order: 2 },
  { id: "corregedoria", name: "Corregedoria", description: "Encaminhamento direto para a corregedoria.", emoji: "⚖️", order: 3 },
  { id: "ouvidoria", name: "Ouvidoria", description: "Enviar manifestacoes, duvidas ou solicitacoes.", emoji: "📋", order: 4 },
  { id: "abuso-de-poder", name: "Abuso de Poder", description: "Denunciar abuso de autoridade ou uso indevido do cargo.", emoji: "🚨", order: 5 },
  { id: "assuntos-internos", name: "Assuntos Internos", description: "Abrir procedimento sigiloso de assuntos internos.", emoji: "🛡️", order: 6 }
];
const policeReportsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  panelChannelId: snowflakeSchema.nullable().default(null),
  categoryId: snowflakeSchema.nullable().default(null),
  archiveCategoryId: snowflakeSchema.nullable().default(null),
  logChannelId: snowflakeSchema.nullable().default(null),
  responsibleRoleId: snowflakeSchema.nullable().default(null),
  responsibleRoleIds: z.array(snowflakeSchema).max(100).default([]),
  maxChannelMinutes: z.coerce.number().int().min(1).max(10080).default(1440),
  initialMessage: z.string().trim().max(1200).default("A equipe responsavel vai dar continuidade ao procedimento por este canal."),
  procedureText: z.string().trim().max(2000).default("Descreva o ocorrido com detalhes e aguarde a analise da equipe responsavel."),
  panelImageUrl: z.string().trim().max(2048).default(""),
  channelImageUrl: z.string().trim().max(2048).default(""),
  footerImageUrl: z.string().trim().max(2048).default(""),
  imagePosition: z.enum(["banner", "thumbnail", "top", "below_title", "middle", "bottom", "side", "footer", "before_buttons", "below_text", "above_buttons", "none"]).default("banner"),
  panelMessageId: snowflakeSchema.nullable().default(null),
  panelTitle: z.string().trim().min(1).max(120).default("Sistema de Denuncias IAB"),
  panelDescription: z.string().trim().max(1200).default("Registre uma denuncia de forma segura e sigilosa."),
  buttonLabel: z.string().trim().max(80).default("Selecionar denuncia"),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#7c3aed"),
  thumbnailUrl: z.string().trim().max(2048).default(""),
  complaintTypes: z.array(policeReportTypeSchema).default(defaultPoliceReportComplaintTypes)
});
const policeReportsSaveSchema = z.object({
  config: policeReportsConfigSchema,
  guildName: z.string().min(1).max(100).optional()
});
const autoUnmuteConfigSchema = z.object({
  enabled: z.boolean().default(false),
  voiceChannelId: snowflakeSchema.nullable().default(null),
  requiredRoleId: snowflakeSchema.nullable().default(null),
  delaySeconds: z.coerce.number().int().min(0).max(60).default(0),
  antiSpamSeconds: z.coerce.number().int().min(1).max(300).default(10)
});
const antiDisconnectConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedRoleIds: z.array(snowflakeSchema).max(100).default([]),
  protectedRoleIds: z.array(snowflakeSchema).max(100).default([]),
  logChannelId: snowflakeSchema.nullable().default(null),
  reconnectDelayMs: z.coerce.number().int().min(250).max(5000).default(800),
  cooldownSeconds: z.coerce.number().int().min(1).max(60).default(5)
});
const antiAbuseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  masterEnabled: z.boolean().default(true),
  antiDisconnectEnabled: z.boolean().default(true),
  antiMuteAbuseEnabled: z.boolean().default(true),
  antiDeafenAbuseEnabled: z.boolean().default(true),
  antiMoveAbuseEnabled: z.boolean().default(true),
  antiKickVoiceEnabled: z.boolean().default(true),
  autoReconnectEnabled: z.boolean().default(true),
  autoUnmuteEnabled: z.boolean().default(true),
  allowedRoleIds: z.array(snowflakeSchema).max(100).default([]),
  immuneRoleIds: z.array(snowflakeSchema).max(100).default([]),
  protectedRoleIds: z.array(snowflakeSchema).max(100).default([]),
  logChannelId: snowflakeSchema.nullable().default(null),
  revertDelayMs: z.coerce.number().int().min(100).max(5000).default(600),
  cooldownSeconds: z.coerce.number().int().min(1).max(60).default(5),
  strictDevOverride: z.boolean().default(true),
  punishAbuser: z.boolean().default(false)
});
const musicConfigSchema = z.object({
  enabled: z.boolean().default(false),
  commandChannelId: snowflakeSchema.nullable().default(null),
  allowedChannelIds: z.array(snowflakeSchema).max(100).default([]),
  blockedChannelIds: z.array(snowflakeSchema).max(100).default([]),
  djRoleId: snowflakeSchema.nullable().default(null),
  permissionMode: z.enum(["everyone", "roles", "administrators"]).default("everyone"),
  allowedRoleIds: z.array(snowflakeSchema).max(100).default([]),
  blockedUserIds: z.array(snowflakeSchema).max(250).default([]),
  defaultVolume: z.coerce.number().int().min(10).max(100).default(50),
  queueLimit: z.coerce.number().int().min(1).max(500).default(100),
  playlistLimit: z.coerce.number().int().min(1).max(100).default(50),
  artistLimit: z.coerce.number().int().min(1).max(50).default(25),
  cooldownSeconds: z.coerce.number().int().min(0).max(60).default(5),
  maxTrackMinutes: z.coerce.number().int().min(1).max(180).default(15),
  idleDisconnectSeconds: z.coerce.number().int().min(5).max(600).default(30),
  allowPlaylists: z.boolean().default(true),
  allowLinks: z.boolean().default(true),
  allowArtistSearch: z.boolean().default(true),
  logChannelId: snowflakeSchema.nullable().default(null)
});
const temporaryVoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  panelChannelId: snowflakeSchema.nullable().default(null),
  panelMessageId: snowflakeSchema.nullable().default(null),
  categoryId: snowflakeSchema.nullable().default(null),
  defaultUserLimit: z.coerce.number().int().min(1).max(99).default(10),
  emptyDeleteMinutes: z.coerce.number().int().min(1).max(1440).default(1),
  logChannelId: snowflakeSchema.nullable().default(null),
  autoDeleteChannelIds: z.array(snowflakeSchema).max(100).default([])
});
const patrolReportsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  systemName: z.string().trim().min(1).max(100).default("Sistema de Relatorios"),
  description: z.string().trim().max(500).default("Registre patrulhamentos com canal temporario e exportacao automatica."),
  panelColor: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/).default("#2563eb"),
  bannerUrl: z.string().trim().max(500).nullable().default(null),
  thumbnailUrl: z.string().trim().max(500).nullable().default(null),
  footerText: z.string().trim().max(200).default("Relatorio de patrulhamento"),
  emojiCreate: z.string().trim().max(80).default("📝"),
  emojiFinish: z.string().trim().max(80).default("✅"),
  emojiExport: z.string().trim().max(80).default("📄"),
  commandChannelId: snowflakeSchema.nullable().default(null),
  logChannelId: snowflakeSchema.nullable().default(null),
  categoryId: snowflakeSchema.nullable().default(null),
  auditChannelId: snowflakeSchema.nullable().default(null),
  creatorRoleId: snowflakeSchema.nullable().default(null),
  viewerRoleId: snowflakeSchema.nullable().default(null),
  deleteRoleId: snowflakeSchema.nullable().default(null),
  adminRoleId: snowflakeSchema.nullable().default(null),
  tempAccessRoleIds: z.array(snowflakeSchema).max(100).default([]),
  channelNameTemplate: z.string().trim().min(1).max(80).default("relatorio-{user}"),
  autoDeleteMinutes: z.coerce.number().int().min(1).max(10080).default(60),
  lockAfterFinish: z.boolean().default(true),
  archiveBeforeDelete: z.boolean().default(true),
  deleteAfterExport: z.boolean().default(false),
  exportPdf: z.boolean().default(true),
  exportHtml: z.boolean().default(true),
  exportJson: z.boolean().default(true),
  exportHeader: z.string().trim().max(200).default("Relatorio de Patrulhamento"),
  exportFooter: z.string().trim().max(200).default("Gerado automaticamente pelo sistema"),
  exportLogoUrl: z.string().trim().max(500).nullable().default(null),
  exportWatermark: z.string().trim().max(100).default(""),
  statsTotalReports: z.boolean().default(true),
  statsTotalPatrolTime: z.boolean().default(true),
  statsOfficerRanking: z.boolean().default(true),
  statsReviewerRanking: z.boolean().default(true),
  statsAveragePatrol: z.boolean().default(true),
  statsLastReport: z.boolean().default(true),
  statsFirstReport: z.boolean().default(true),
  componentButtonText: z.string().trim().max(80).default("Finalizar relatorio"),
  componentSelectText: z.string().trim().max(100).default("Selecione uma acao"),
  componentOrder: z.string().trim().max(120).default("panel,finish,export,stats")
});
const tagVerificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  requiredTag: z.string().trim().max(100).default(""),
  roleId: snowflakeSchema.nullable().default(null),
  updateIntervalMinutes: z.coerce.number().int().min(1).max(1440).default(10),
  autoRemove: z.boolean().default(true),
  updatedAt: z.string().datetime()
}).superRefine((config, context) => {
  if (!config.enabled) return;

  if (!config.requiredTag) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Informe a tag exigida.", path: ["requiredTag"] });
  }

  if (!config.roleId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Selecione o cargo que sera entregue.", path: ["roleId"] });
  }
});

type TagVerificationRunResult = {
  botId: string;
  guildId: string;
  checked: number;
  assigned: number;
  removed: number;
  ignored: number;
  unavailable: number;
  errors: number;
  lastCheckAt: string;
  nextCheckAt: string | null;
  lastError: string | null;
};

export const advancedModulesRouter = Router();

advancedModulesRouter.use(requireAuth);

advancedModulesRouter.get("/:botId/:guildId/:moduleId", async (req, res, next) => {
  try {
    const botId = botIdSchema.parse(req.params.botId);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const moduleId = moduleIdSchema.parse(req.params.moduleId);
    const user = res.locals.dashboardAuth.user as AuthSessionUser;

    if (!(await canReadDevBotModule(user, botId, guildId, moduleId))) {
      return res.status(403).json({
        message: "Este modulo nao foi liberado para este bot ou voce nao tem permissao para visualiza-lo."
      });
    }

    return res.json({
      module: await getBotGuildModuleConfig(botId, guildId, moduleId)
    });
  } catch (error) {
    return next(error);
  }
});

advancedModulesRouter.patch("/:botId/:guildId/:moduleId", async (req, res, next) => {
  try {
    const botId = botIdSchema.parse(req.params.botId);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const moduleId = moduleIdSchema.parse(req.params.moduleId);
    const input = moduleId === "police-reports" ? policeReportsSaveSchema.parse(req.body ?? {}) : saveSchema.parse(req.body ?? {});
    const user = res.locals.dashboardAuth.user as AuthSessionUser;

    if (!(await canUseDevBotModule(user, botId, guildId, moduleId))) {
      return res.status(403).json({
        message: "Este modulo nao foi liberado para este bot ou voce nao tem permissao para configura-lo."
      });
    }

    if (moduleId === "anti-ban") {
      return res.status(409).json({
        message: "Use a configuração dedicada do Anti Ban para validar permissões, limites e canal de logs."
      });
    }

    const previous = await getBotGuildModuleConfig(botId, guildId, moduleId);
    const normalizedConfig = normalizeModuleConfig(moduleId, input.config);

    if (moduleId === "tag-verification" && normalizedConfig.enabled === true) {
      await validateTagVerificationRole(botId, guildId, String((normalizedConfig as Record<string, unknown>).roleId));
    }

    const savedModule = await updateBotGuildModuleConfig({
      botId,
      guildId,
      guildName: input.guildName ?? `Servidor ${guildId}`,
      moduleId,
      config: {
        ...normalizedConfig,
        ...(moduleId === "police-reports" ? { panelMessageId: previous.config.panelMessageId ?? null } : {}),
        ...(moduleId === "tag-verification" ? { botId, guildId } : {}),
        updatedBy: user.id
      }
    });

    await writeModuleConfigLogs({
      botId,
      config: savedModule.config,
      guildId,
      moduleId,
      previousConfig: previous.config,
      user
    });

    if (moduleId === "tag-verification") {
      emitRealtimeToRoom(devBotRealtimeRoom(botId), "tag-verification:config_updated", {
        botId,
        guildId
      });
    }
    if (moduleId === "police-reports") {
      emitRealtimeToRoom(devBotRealtimeRoom(botId), "police-reports:panel_update", { action: "update", botId, guildId });
    }

    return res.json({
      module: savedModule
    });
  } catch (error) {
    return next(error);
  }
});

advancedModulesRouter.post("/:botId/:guildId/police-reports/publish", async (req, res, next) => {
  try {
    const botId = botIdSchema.parse(req.params.botId);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const user = res.locals.dashboardAuth.user as AuthSessionUser;
    if (!(await canUseDevBotModule(user, botId, guildId, "police-reports"))) {
      return res.status(403).json({ message: "Este modulo nao foi liberado para este bot ou servidor." });
    }
    const module = await getBotGuildModuleConfig(botId, guildId, "police-reports");
    const config = policeReportsConfigSchema.parse(module.config);
    if (!config.complaintTypes.length) {
      return res.status(409).json({ message: "Cadastre ao menos um tipo de denuncia antes de publicar o painel." });
    }
    if (!config.panelChannelId) {
      return res.status(409).json({ message: "Configure o canal do painel antes de publicar." });
    }
    if (!config.categoryId) {
      return res.status(409).json({ message: "Configure a categoria onde os canais de denuncia serao criados." });
    }
    if (!config.archiveCategoryId) {
      return res.status(409).json({ message: "Configure a categoria para onde o canal sera enviado depois de finalizado." });
    }
    emitRealtimeToRoom(devBotRealtimeRoom(botId), "police-reports:panel_update", { action: "publish", botId, guildId });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

advancedModulesRouter.post("/:botId/:guildId/tag-verification/run", async (req, res, next) => {
  try {
    const botId = botIdSchema.parse(req.params.botId);
    const guildId = guildIdSchema.parse(req.params.guildId);
    const user = res.locals.dashboardAuth.user as AuthSessionUser;

    if (!(await canUseDevBotModule(user, botId, guildId, "tag-verification"))) {
      return res.status(403).json({ message: "Este modulo nao foi liberado para este bot ou servidor." });
    }

    const module = await getBotGuildModuleConfig(botId, guildId, "tag-verification");

    if (module.config.enabled !== true) {
      return res.status(409).json({ message: "Ative e salve a Verificacao de Tag antes de executar." });
    }

    const responses = await emitRealtimeToRoomWithAck<
      { botId: string; guildId: string },
      TagVerificationRunResult | { error: string }
    >(devBotRealtimeRoom(botId), "tag-verification:run", { botId, guildId }, 120_000);
    const result = responses.find((item): item is TagVerificationRunResult => "checked" in item);

    if (!result) {
      const error = responses.find((item): item is { error: string } => "error" in item)?.error;
      return res.status(503).json({ message: error || "O bot nao respondeu a verificacao manual." });
    }

    return res.json({ result });
  } catch (error) {
    return next(error);
  }
});

function normalizeModuleConfig(moduleId: z.infer<typeof moduleIdSchema>, config: Record<string, unknown>) {
  if (moduleId === "auto-unmute") {
    return autoUnmuteConfigSchema.parse({
      antiSpamSeconds: config.antiSpamSeconds,
      delaySeconds: config.delaySeconds,
      enabled: config.enabled,
      requiredRoleId: config.requiredRoleId || null,
      voiceChannelId: config.voiceChannelId || null
    });
  }

  if (moduleId === "anti-disconnect") {
    return antiDisconnectConfigSchema.parse({
      allowedRoleIds: Array.isArray(config.allowedRoleIds) ? config.allowedRoleIds : [],
      cooldownSeconds: config.cooldownSeconds,
      enabled: config.enabled,
      logChannelId: config.logChannelId || null,
      protectedRoleIds: Array.isArray(config.protectedRoleIds) ? config.protectedRoleIds : [],
      reconnectDelayMs: config.reconnectDelayMs
    });
  }

  if (moduleId === "anti-abuse") {
    return antiAbuseConfigSchema.parse({
      allowedRoleIds: Array.isArray(config.allowedRoleIds) ? config.allowedRoleIds : [],
      antiDeafenAbuseEnabled: config.antiDeafenAbuseEnabled,
      antiDisconnectEnabled: config.antiDisconnectEnabled,
      antiKickVoiceEnabled: config.antiKickVoiceEnabled,
      antiMoveAbuseEnabled: config.antiMoveAbuseEnabled,
      antiMuteAbuseEnabled: config.antiMuteAbuseEnabled,
      autoReconnectEnabled: config.autoReconnectEnabled,
      autoUnmuteEnabled: config.autoUnmuteEnabled,
      cooldownSeconds: config.cooldownSeconds,
      enabled: config.enabled,
      immuneRoleIds: Array.isArray(config.immuneRoleIds) ? config.immuneRoleIds : [],
      logChannelId: config.logChannelId || null,
      masterEnabled: config.masterEnabled,
      protectedRoleIds: Array.isArray(config.protectedRoleIds) ? config.protectedRoleIds : [],
      punishAbuser: config.punishAbuser,
      revertDelayMs: config.revertDelayMs,
      strictDevOverride: config.strictDevOverride
    });
  }

  if (moduleId === "music") {
    return musicConfigSchema.parse(config);
  }

  if (moduleId === "temporary-voice") {
    return temporaryVoiceConfigSchema.parse(config);
  }

  if (moduleId === "patrol-reports") {
    return patrolReportsConfigSchema.parse({
      ...config,
      bannerUrl: config.bannerUrl || null,
      thumbnailUrl: config.thumbnailUrl || null,
      commandChannelId: config.commandChannelId || null,
      logChannelId: config.logChannelId || null,
      categoryId: config.categoryId || null,
      auditChannelId: config.auditChannelId || null,
      creatorRoleId: config.creatorRoleId || null,
      viewerRoleId: config.viewerRoleId || null,
      deleteRoleId: config.deleteRoleId || null,
      adminRoleId: config.adminRoleId || null,
      tempAccessRoleIds: Array.isArray(config.tempAccessRoleIds) ? config.tempAccessRoleIds : [],
      exportLogoUrl: config.exportLogoUrl || null
    });
  }

  if (moduleId === "tag-verification") {
    const result = tagVerificationConfigSchema.safeParse({
      autoRemove: config.autoRemove ?? config.removeOnMismatch,
      enabled: config.enabled,
      requiredTag: config.requiredTag,
      roleId: config.roleId,
      updateIntervalMinutes: config.updateIntervalMinutes ?? config.intervalMinutes,
      updatedAt: new Date().toISOString()
    });

    if (!result.success) {
      const error = new Error(result.error.issues[0]?.message ?? "Configuracao de Verificacao de Tag invalida.");
      Object.assign(error, { statusCode: 400 });
      throw error;
    }

    return result.data;
  }

  if (moduleId === "police-reports") {
    const parsed = policeReportsConfigSchema.parse(config);
    const complaintTypes = parsed.complaintTypes.length ? parsed.complaintTypes : defaultPoliceReportComplaintTypes;
    return {
      ...parsed,
      complaintTypes: complaintTypes
        .map((item, index) => ({ ...item, order: Number.isFinite(item.order) ? item.order : index }))
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    };
  }

  return config;
}

async function validateTagVerificationRole(botId: string, guildId: string, roleId: string) {
  const token = await getDevBotToken(botId);
  if (!token) {
    const error = new Error("O token deste bot nao esta disponivel para validar o cargo.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  const validation = await validateGuildAssignableRole(guildId, roleId, token);

  if (validation.ok) {
    return;
  }

  const messages = {
    bot_missing_manage_roles: "Bot sem permissao para gerenciar cargos.",
    role_above_bot: "Cargo selecionado esta acima do cargo do bot.",
    role_managed: "Cargo selecionado e gerenciado por uma integracao.",
    role_not_found: "Cargo nao encontrado."
  } as const;

  const error = new Error(validation.reason ? messages[validation.reason] : "Nao foi possivel validar o cargo selecionado.");
  Object.assign(error, { statusCode: 400 });
  throw error;
}

async function writeModuleConfigLogs(input: {
  botId: string;
  config: Record<string, unknown>;
  guildId: string;
  moduleId: string;
  previousConfig: Record<string, unknown>;
  user: AuthSessionUser;
}) {
  const label = input.moduleId === "auto-unmute" ? "Auto Desmutar" : input.moduleId === "anti-disconnect" ? "Anti Disconnect" : input.moduleId === "anti-abuse" ? "Anti Abuse" : input.moduleId === "tag-verification" ? "Verificacao de Tag" : input.moduleId;
  const enabled = input.config.enabled === true;
  const wasEnabled = input.previousConfig.enabled === true;

  await createLog({
    botId: input.botId,
    guildId: input.guildId,
    userId: input.user.discordId ?? input.user.id,
    type: `${input.moduleId}.config_updated`,
    message: `${label}: configuracao salva para este bot e servidor.`,
    metadata: {
      botId: input.botId,
      guildId: input.guildId,
      moduleId: input.moduleId,
      ...(input.moduleId === "tag-verification" ? {
        autoRemove: input.config.autoRemove,
        requiredTag: input.config.requiredTag,
        roleId: input.config.roleId,
        updateIntervalMinutes: input.config.updateIntervalMinutes
      } : {})
    }
  }).catch(() => undefined);

  if (enabled === wasEnabled) {
    return;
  }

  await createLog({
    botId: input.botId,
    guildId: input.guildId,
    userId: input.user.discordId ?? input.user.id,
    type: enabled ? `${input.moduleId}.enabled` : `${input.moduleId}.disabled`,
    message: `${label}: sistema ${enabled ? "ativado" : "pausado"} neste bot e servidor.`,
    metadata: {
      botId: input.botId,
      guildId: input.guildId,
      moduleId: input.moduleId
    }
  }).catch(() => undefined);
}
