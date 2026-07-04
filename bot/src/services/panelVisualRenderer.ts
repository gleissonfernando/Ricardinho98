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
    return url ? [{ block: mediaBlock(url, input.title), position: normalizePosition(image?.imagePosition) }] : [];
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
  } else {
    components.push({ type: 10, content: titleText });
  }
  components.push(...extraMedia.filter((item) => ["thumbnail", "side"].includes(item.position)).map((item) => item.block));
  pushMedia(["below_title", "below_text"]);

  const split = Math.ceil(fields.length / 2);
  fields.slice(0, split).forEach((content) => components.push({ type: 10, content }));
  pushMedia(["middle"]);
  fields.slice(split).forEach((content) => components.push({ type: 10, content }));
  pushMedia(["before_buttons", "above_buttons"]);
  pushMedia(["bottom", "footer"]);
  if (input.footerText) {
    components.push({ type: 14, divider: true, spacing: 1 });
    components.push(compactSection(input.footerText, footerIconUrl));
  }
  components.push(...actions);

  return {
    allowedMentions: { parse: [] as never[] },
    components: [{ type: 17, accent_color: input.accentColor, components }],
    flags: MessageFlags.IsComponentsV2 as const
  };
}

export function resolvePanelImageUrl(value: string | null) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const origin = env.BACKEND_API_URL ? new URL(env.BACKEND_API_URL).origin : "";
  return origin ? `${origin}${value.startsWith("/") ? value : `/${value}`}` : null;
}

function mediaBlock(url: string, description: string) { return { type: 12, items: [{ media: { url }, description }] }; }
function compactSection(content: string, iconUrl: string | null) {
  return iconUrl
    ? { type: 9, components: [{ type: 10, content }], accessory: { type: 11, media: { url: iconUrl }, description: content.replace(/[*_#]/g, "").slice(0, 100) } }
    : { type: 10, content };
}
function normalizePosition(position: PanelVisualPosition | undefined): PanelVisualPosition { return position && position !== "none" ? position : "none"; }
