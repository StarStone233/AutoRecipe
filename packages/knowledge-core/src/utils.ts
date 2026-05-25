import { createHash, randomUUID } from "node:crypto";
import { URL } from "node:url";

export function utcNowIso(): string {
  return new Date().toISOString();
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return `run_${stamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function normalizeIdentifier(value: string, fallback = "default"): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

export function systemKeyFromUrl(rawUrl: string): string {
  try {
    return normalizeIdentifier(new URL(rawUrl).hostname);
  } catch {
    return "default";
  }
}

export function hostFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostSuffix(host: string): string {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  if (parts.every((part) => /^\d+$/.test(part))) return parts.join(".");
  return parts.slice(-2).join(".");
}

export function normalizePathTemplate(pathname: string): string {
  const raw = pathname || "/";
  return raw
    .replace(/\/\d+(?=\/|$)/g, "/{id}")
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/{id}")
    .replace(/\/[0-9a-f-]{20,}(?=\/|$)/gi, "/{id}") || "/";
}

export function pageIdFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return normalizeIdentifier(`${url.hostname}${normalizePathTemplate(url.pathname)}`);
  } catch {
    return normalizeIdentifier(rawUrl || "page");
  }
}

export function hashObject(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((item) => item.trim()).filter(Boolean))].sort();
}

export function maskSample(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length > 120) return `${text.slice(0, 117)}...`;
  if (/password|token|secret|authorization/i.test(text)) return "***";
  return text;
}

export function inferRegion(payload: Record<string, unknown>): string {
  const explicit = String(payload.region || "").trim();
  if (explicit) return explicit;
  const text = [
    payload.label,
    payload.text,
    payload.role,
    payload.class_name,
    payload.element_id,
    payload.data_testid,
  ].map((item) => String(item || "").toLowerCase()).join(" ");
  if (/header|navbar|breadcrumb|top|toolbar/.test(text)) return "top_bar";
  if (/sidebar|sider|menu|navigation|tree|left/.test(text)) return "left_nav";
  if (/filter|search|query|condition|form/.test(text)) return "filter_panel";
  if (/table|grid|result|list/.test(text)) return "result_table";
  if (/dialog|modal|popup|drawer/.test(text)) return "modal_dialog";

  const x = Number(payload.x || 0);
  const y = Number(payload.y || 0);
  const width = Math.max(1, Number(payload.viewport_width || 1280));
  const height = Math.max(1, Number(payload.viewport_height || 720));
  if (y < height * 0.16) return "top_bar";
  if (x < width * 0.2) return "left_nav";
  if (x > width * 0.82) return "right_panel";
  if (y < height * 0.42) return "operation_bar";
  return "main_content";
}

export function styleFingerprint(styles: Record<string, unknown>): string {
  const keys = [
    "display", "visibility",
    "bg", "color",
    "font_family", "font_size", "font_weight",
    "border_radius", "border_width",
    "cursor", "overflow",
    "tag", "role", "type",
    "w_pct", "h_pct",
  ] as const;
  const parts: string[] = [];
  for (const key of keys) {
    const value = styles[key];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${key}:${String(value)}`);
    }
  }
  const raw = parts.join("|");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hammingDistance(a: string, b: string): number {
  const hexA = a.replace(/[^0-9a-f]/gi, "");
  const hexB = b.replace(/[^0-9a-f]/gi, "");
  const len = Math.min(hexA.length, hexB.length);
  let distance = 0;
  for (let i = 0; i < len; i++) {
    const byte = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    distance += (byte & 1) + ((byte >> 1) & 1) + ((byte >> 2) & 1) + ((byte >> 3) & 1);
  }
  return distance + Math.abs(hexA.length - hexB.length) * 4;
}

export function computeRegionBbox(params: {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  region: string;
  regions: Array<{ region: string; x_pct: number; y_pct: number; width_pct: number; height_pct: number }>;
}): { region_x_pct: number; region_y_pct: number; region_w_pct: number; region_h_pct: number } | undefined {
  const regionBox = params.regions.find((r) => r.region === params.region);
  if (!regionBox || regionBox.width_pct <= 0 || regionBox.height_pct <= 0) return undefined;
  return {
    region_x_pct: clampPct((params.xPct - regionBox.x_pct) / regionBox.width_pct * 100),
    region_y_pct: clampPct((params.yPct - regionBox.y_pct) / regionBox.height_pct * 100),
    region_w_pct: clampPct(params.wPct / regionBox.width_pct * 100),
    region_h_pct: clampPct(params.hPct / regionBox.height_pct * 100),
  };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

export function bboxOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const overlapX = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const overlapArea = overlapX * overlapY;
  const areaA = a.w * a.h || 1;
  const areaB = b.w * b.h || 1;
  return overlapArea / Math.min(areaA, areaB);
}
