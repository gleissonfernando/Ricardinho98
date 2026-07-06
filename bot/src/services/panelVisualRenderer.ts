import { MessageFlags } from "discord.js";
import { env } from "../config/env";

export type PanelVisualPosition = "banner" | "thumbnail" | "top" | "below_title" | "middle" | "bottom" | "side" | "footer" | "before_buttons" | "below_text" | "above_buttons" | "none";

export type PanelVisualConfig = {
  imageEnabled?: boolean;
  imagePosition?: PanelVisualPosition;
  imageUrl?: string | null;
};

export function renderComponentsV2Panel(input: {
  accentColor: number;
  actions?: unknown[];
  description: string;
  extraImages?: Array<PanelVisualConfig | null | undefined>;
  fields?: string[];
  footerIcon?: PanelVisualConfig | null;
  footerText?: string;
  headerIcon?: PanelVisualConfig | null;
  headerText?: string;
  image?: PanelVisualConfig | null;
  moduleId: string;
  title: string;
}) {
  const imageUrl = input.image?.imageEnabled ? resolvePanelImageUrl(input.image.imageUrl ?? null) : null;
  const position = imageUrl ? normalizePosition(input.image?.imagePosition) : "none";
  const extraMedia = (input.extraImages ?? []).flatMap((image) => {
    const url = image?.imageEnabled ? resolvePanelImageUrl(image.imageUrl ?? null) : null;
    return url ? [{ url, block: mediaBlock(url, input.title), position: normalizePosition(image?.imagePosition) }] : [];
  }).slice(0, 2);
  const actions = input.actions ?? [];
  const fields = input.fields ?? [];
  const components: unknown[] = [];
  const media = imageUrl ? mediaBlock(imageUrl, input.title) : null;
  const titleText = `# ${input.title}\n${input.description}`;
  const headerIconUrl = input.headerIcon?.imageEnabled ? resolvePanelImageUrl(input.headerIcon.imageUrl ?? null) : null;
  const footerIconUrl = input.footerIcon?.imageEnabled ? resolvePanelImageUrl(input.footerIcon.imageUrl ?? null) : null;
  if (input.headerText) components.push(compactSection(input.headerText, headerIconUrl));
  const pushMedia = (positions: PanelVisualPosition[]) => {
    if (media && positions.includes(position)) components.push(media);
    components.push(...extraMedia.filter((item) => positions.includes(item.position)).map((item) => item.block));
  };

  pushMedia(["top", "banner"]);
  if (media && ["thumbnail", "side"].includes(position)) {
    components.push({ type: 9, components: [{ type: 10, content: titleText }], accessory: { type: 11, media: { url: imageUrl }, description: input.title } });
  } else if (extraMedia.some((item) => ["thumbnail", "side"].includes(item.position))) {
    const side = extraMedia.find((item) => ["thumbnail", "side"].includes(item.position))!;
    components.push({ type: 9, components: [{ type: 10, content: titleText }], accessory: { type: 11, media: { url: side.url }, description: input.title } });
  } else {
    components.push({ type: 10, content: titleText });
  }
  components.push(...extraMedia.filter((item) => ["thumbnail", "side"].includes(item.position)).slice(1).map((item) => item.block));
  pushMedia(["below_title", "below_text"]);

  const split = Math.ceil(fields.length / 2);
  fields.slice(0, split).forEach((content) => components.push({ type: 10, content }));
  pushMedia(["middle"]);
  fields.slice(split).forEach((content) => components.push({ type: 10, content }));
  pushMedia(["before_buttons", "above_buttons"]);
  pushMedia(["bottom"]);
  const extraFooterIconUrl = extraMedia.find((item) => item.position === "footer")?.url ?? null;
  if (input.footerText) {
    components.push({ type: 14, divider: true, spacing: 1 });
    components.push(compactSection(input.footerText, footerIconUrl ?? extraFooterIconUrl));
  }
  components.push(...actions);

  return {
    allowedMentions: { parse: [] as never[] },
    components: [{ type: 17, accent_color: input.accentColor, components }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

export function resolvePanelImageUrl(value: string | null) {
  const normalized = normalizeImageUrl(value);
  if (!normalized) return null;
  if (/^https:\/\//i.test(normalized)) return isPublicDiscordImageUrl(normalized) ? normalized : null;
  if (!normalized.startsWith("/")) return null;
  const origin = publicBackendOrigin();
  if (!origin) return null;
  const absoluteUrl = `${origin}${normalized}`;
  return isPublicDiscordImageUrl(absoluteUrl) ? absoluteUrl : null;
}

function mediaBlock(url: string, description: string) { return { type: 12, items: [{ media: { url }, description }] }; }
function compactSection(content: string, iconUrl: string | null) {
  return iconUrl
    ? { type: 9, components: [{ type: 10, content }], accessory: { type: 11, media: { url: iconUrl }, description: content.replace(/[*_#]/g, "").slice(0, 100) } }
    : { type: 10, content };
}
function normalizePosition(position: PanelVisualPosition | undefined): PanelVisualPosition { return position && position !== "none" ? position : "none"; }

function normalizeImageUrl(value: string | null) {
  const trimmed = value?.trim();
  if (!trimmed || /^blob:/i.test(trimmed) || /^data:/i.test(trimmed)) return null;
  return trimmed;
}

function publicBackendOrigin() {
  try {
    const origin = env.BACKEND_API_URL ? new URL(env.BACKEND_API_URL).origin : "";
    return origin && isPublicHttpsOrigin(origin) ? origin : "";
  } catch {
    return "";
  }
}

function isPublicDiscordImageUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (isLocalHostname(url.hostname)) return false;
    return /\.(png|jpe?g|gif|webp)(?:$|[?#])/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isPublicHttpsOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "0.0.0.0"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized.endsWith(".local");
}
