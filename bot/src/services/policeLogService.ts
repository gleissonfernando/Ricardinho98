import { MessageFlags, type Guild } from "discord.js";
import { renderComponentsV2Panel, type PanelVisualConfig } from "./panelVisualRenderer";

export type PoliceLogField = {
  name: string;
  value: string | number | boolean | null | undefined;
};

export type PoliceLogInput = {
  action: string;
  actorId?: string | null;
  channelId?: string | null;
  color?: number;
  fields?: PoliceLogField[];
  footerImage?: PanelVisualConfig | null;
  id?: string | null;
  image?: PanelVisualConfig | null;
  title: string;
};

export async function sendPoliceLog(guild: Guild, channelIds: Array<string | null | undefined>, input: PoliceLogInput) {
  const targets = uniqueIds(channelIds);
  if (!targets.length) return;

  await Promise.allSettled(targets.map(async (channelId) => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    await channel.send(policeLogPayload(guild, input)).catch(() => undefined);
  }));
}

export function policeLogPayload(guild: Guild, input: PoliceLogInput) {
  const id = input.id ?? `${Date.now()}`;
  const fields = [
    input.actorId ? `**Usuario**\n<@${input.actorId}>\nID do Usuário: ${input.actorId}` : null,
    `**Registro**\n${input.action}`,
    ...(input.fields ?? []).map((field) => {
      const value = field.value === null || field.value === undefined || field.value === "" ? "-" : String(field.value);
      return `**${field.name}**\n${value}`;
    }),
    `**Canal**\n${input.channelId ? `<#${input.channelId}>` : "Canal não informado"}\nServerId: ${guild.name}`
  ].filter((field): field is string => Boolean(field));

  return {
    allowedMentions: { parse: [] as never[] },
    components: renderComponentsV2Panel({
      accentColor: input.color ?? 0x2b2d31,
      description: "",
      fields,
      footerIcon: input.footerImage ?? null,
      footerText: smallFooter(`ID do registro: ${id} - ${formatFooterDate(new Date())}`),
      image: input.image ?? null,
      moduleId: "police-logs",
      title: `Registro de ${input.title}`
    }).components,
    flags: MessageFlags.IsComponentsV2 as const
  };
}

function uniqueIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && /^\d{5,32}$/.test(value)))];
}

function formatFooterDate(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric"
  }).format(value).replace(",", "");
}

function smallFooter(value: string) {
  return value.trim().startsWith("-#") ? value.trim() : `-# ${value.trim()}`;
}
