import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import {
  CaptureEvent,
  CaptureEventSchema,
  ActionRulesArtifact,
  ActionRule,
  ActionTraceArtifact,
  ActionTraceStep,
  BusinessCatalogArtifact,
  BusinessCatalogModule,
  ElementAsset,
  ElementMapArtifact,
  EvidenceIndexArtifact,
  NavigationEdge,
  OperationManual,
  PageMapArtifact,
  PageMapPage,
  PageSurface,
  PercentBbox,
  RecipePack,
  RegionPartition,
  RequestRecord,
  RequestCatalogArtifact,
  SemanticAnnotationsArtifact,
  SystemCapability,
  SystemCapabilityStep,
} from "./schemas.js";
import { KnowledgeStore } from "./storage.js";
import { enrichWithSemanticData, applyEnrichmentToArtifacts } from "./semanticEnrichment.js";
import { describeCapability } from "./llmClient.js";
import type { LLMConfig } from "./llmClient.js";
import {
  bboxOverlap,
  computeRegionBbox,
  hashObject,
  hammingDistance,
  hostFromUrl,
  inferRegion,
  maskSample,
  normalizeIdentifier,
  normalizePathTemplate,
  pageIdFromUrl,
  styleFingerprint,
  uniqueSorted,
  utcNowIso,
} from "./utils.js";

const SKIPPED_MERGE_MANIFEST_STATUSES = new Set(["interrupted_auth_expired", "quarantine", "auth_required"]);
const SKIPPED_MERGE_AUTH_STATUSES = new Set(["required", "expired", "blocked"]);
const MERGEABLE_AUTH_STATUSES = new Set(["ready", "not_required", "unknown"]);

type ClickTrace = {
  action_id: string;
  ts: string;
  ts_ms: number;
  page_url: string;
  page_id: string;
  element_id: string;
  region: string;
  label: string;
  event_type: string;
  request_signatures: string[];
  next_page: string;
  evidence_refs: string[];
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
  surface_id: string;
  surface_kind: PageSurface["surface_kind"];
  surface_label: string;
  surface_bbox: PercentBbox;
  surface_bbox_in_viewport: PercentBbox;
  region_bbox: Record<string, number>;
  style_fingerprint: string;
  direct_text: string;
  tag: string;
  role: string;
};

type RequestRecordDraft = Omit<RequestRecord, "page_urls"> & {
  page_urls: Set<string>;
  status_codes: Set<number>;
};

type HeatZone = PageMapPage["heat_zones"][number];
type SurfaceHeatZone = PageSurface["heat_zones"][number];

const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "co.uk",
  "org.uk",
  "com.au",
  "net.au",
  "co.jp",
]);

function tsMs(value: string | undefined, fallback: number): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eventUrl(event: CaptureEvent): string {
  return String(event.payload.page_url || event.url || event.payload.document_url || "").trim();
}

function learningScopeFromRun(run: { target_host_suffix?: string; entry_url?: string; url?: string }): string {
  const explicit = String(run.target_host_suffix || "").trim().toLowerCase();
  if (explicit) return registrableDomainFromHost(explicit.replace(/^\./, ""));
  return learningScopeFromUrl(run.entry_url || run.url || "");
}

function learningScopeFromUrl(value: string): string {
  try {
    return registrableDomainFromHost(new URL(value).hostname);
  } catch {
    return "";
  }
}

function registrableDomainFromHost(host: string): string {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(normalized) || normalized.includes(":")) return normalized;
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) return normalized;
  const suffix2 = parts.slice(-2).join(".");
  if (TWO_LEVEL_PUBLIC_SUFFIXES.has(suffix2) && parts.length >= 3) return parts.slice(-3).join(".");
  return suffix2;
}

function urlInLearningScope(value: string, scope: string): boolean {
  if (!scope) return true;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === scope || host.endsWith(`.${scope}`);
  } catch {
    return false;
  }
}

function querySample(url: URL): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const rows = out[key] || [];
    if (rows.length < 3) rows.push(maskSample(value));
    out[key] = rows;
  }
  return out;
}

function bodySummary(payload: Record<string, unknown>): { bodyKeys: string[]; bodySample: Record<string, string[]>; bodyFormat: string } {
  const body = payload.body_summary;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const row = body as Record<string, unknown>;
    return {
      bodyKeys: Array.isArray(row.body_keys) ? row.body_keys.map(String).sort() : [],
      bodySample: row.body_sample && typeof row.body_sample === "object" ? row.body_sample as Record<string, string[]> : {},
      bodyFormat: String(row.body_format || row.format || "unknown"),
    };
  }
  return {
    bodyKeys: Array.isArray(payload.body_keys) ? payload.body_keys.map(String).sort() : [],
    bodySample: payload.body_sample && typeof payload.body_sample === "object" ? payload.body_sample as Record<string, string[]> : {},
    bodyFormat: String(payload.body_format || "none"),
  };
}

function classifyRequest(url: URL, resourceType: string): { category: string; effective: boolean; reason: string } {
  const text = `${url.hostname}${url.pathname}`.toLowerCase();
  if (resourceType && !["fetch", "xhr"].includes(resourceType)) {
    return { category: "background", effective: false, reason: "non_fetch_xhr" };
  }
  if (/track|tracking|collect|beacon|metric|analytics|rum|sentry|otel|trace|telemetry|monitor|log|pixel|tag|ad[s]?[./]|banner|promo/.test(text)) {
    return { category: "tracking", effective: false, reason: "tracking" };
  }
  if (/\.(js|css|png|jpg|jpeg|svg|gif|woff2?|ico|map)$/.test(url.pathname.toLowerCase())) {
    return { category: "background", effective: false, reason: "static_resource" };
  }
  // Static resource paths without extensions
  if (/\/static\/|\/assets\/|\/public\/|\/dist\/|\/build\/|\/chunks?\//.test(url.pathname.toLowerCase())) {
    return { category: "background", effective: false, reason: "static_path" };
  }
  // Common non-business API patterns
  if (/\/xlsc|\/beacon|\/ping|\/health|\/status|\/ready|\/alive|\/metrics|\/debug|\/config|\/settings/.test(url.pathname.toLowerCase())) {
    return { category: "background", effective: false, reason: "infra_api" };
  }
  return { category: "business", effective: true, reason: "business_api" };
}

function eventAction(eventType: string): string[] {
  if (eventType === "ui_click" || eventType === "ui_pointer_end") return ["click"];
  if (eventType === "ui_input" || eventType === "ui_change" || eventType === "ui_select") return ["fill"];
  if (eventType === "ui_submit") return ["submit", "save"];
  if (eventType === "ui_keydown") return ["key"];
  if (eventType === "ui_pointer_start") return ["drag_start"];
  return [];
}

function stableElementId(params: {
  systemKey: string;
  pageUrl: string;
  region: string;
  eventType: string;
  regionBbox?: Record<string, number>;
  xPct?: number;
  yPct?: number;
}): string {
  const parts = [
    params.systemKey,
    pageIdFromUrl(params.pageUrl),
    params.region || "main_content",
  ];
  const rb = params.regionBbox;
  if (rb && rb.region_x_pct !== undefined && rb.region_y_pct !== undefined) {
    parts.push(`b_${coordinateBucket(rb.region_x_pct)}_${coordinateBucket(rb.region_y_pct)}`);
  } else if (params.xPct !== undefined && params.yPct !== undefined) {
    parts.push(`p_${coordinateBucket(params.xPct)}_${coordinateBucket(params.yPct)}`);
  }
  return normalizeIdentifier(parts.join(":"));
}

function coordinateBucket(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const bucket = Math.round(value / 2) * 2;
  return String(Math.max(0, Math.min(100, bucket)));
}

function isTextEntryEvent(eventType: string): boolean {
  return eventType === "ui_input" || eventType === "ui_change" || eventType === "ui_keydown";
}

function textEntryKey(action: ClickTrace): string {
  return `${action.page_id}:${action.element_id}:${action.region}`;
}

function isEditableTextAction(action: ClickTrace): boolean {
  const tag = action.tag.toLowerCase();
  const role = action.role.toLowerCase();
  return tag === "input"
    || tag === "textarea"
    || role === "textbox"
    || role === "searchbox"
    || action.region === "filter_panel";
}

function mergeTextEntryAction(target: ClickTrace, group: ClickTrace[]): ClickTrace {
  return {
    ...target,
    event_type: "ui_input",
    request_signatures: uniqueSorted(group.flatMap((item) => item.request_signatures)),
    evidence_refs: uniqueSorted(group.flatMap((item) => item.evidence_refs)),
  };
}

function foldTextEntryActions(actions: ClickTrace[]): ClickTrace[] {
  const folded: ClickTrace[] = [];
  const groups = new Map<string, ClickTrace[]>();
  const emittedTextByTarget = new Map<string, { label: string; index: number }>();

  const flushAll = () => {
    for (const [key, group] of groups.entries()) {
      const finalText = [...group].reverse().find((item) => item.label.trim());
      if (!finalText) continue;
      const merged = mergeTextEntryAction(finalText, group);
      const previous = emittedTextByTarget.get(key);
      if (previous?.label === merged.label) {
        folded[previous.index] = mergeTextEntryAction(folded[previous.index], [folded[previous.index], ...group]);
      } else {
        emittedTextByTarget.set(key, { label: merged.label, index: folded.length });
        folded.push(merged);
      }
    }
    groups.clear();
  };

  for (const action of actions) {
    if (isTextEntryEvent(action.event_type)) {
      if (!isEditableTextAction(action)) continue;
      const key = textEntryKey(action);
      groups.set(key, [...(groups.get(key) || []), action]);
      continue;
    }
    flushAll();
    folded.push(action);
  }
  flushAll();

  return folded;
}

function dropTextFocusActions(actions: ClickTrace[]): ClickTrace[] {
  const filledTargets = new Set(
    actions
      .filter((action) => action.event_type === "ui_input" && isEditableTextAction(action))
      .map(textEntryKey),
  );
  return actions.filter((action) => {
    if (!["ui_click", "ui_pointer_start", "ui_pointer_end"].includes(action.event_type)) return true;
    return !(filledTargets.has(textEntryKey(action)) && isEditableTextAction(action));
  });
}

function dropDuplicateSubmitActions(actions: ClickTrace[]): ClickTrace[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (action.event_type !== "ui_submit") return true;
    const key = `${action.event_type}:${textEntryKey(action)}:${action.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignNextPages(actions: ClickTrace[], fallbackUrl: string): void {
  for (let i = 0; i < actions.length; i += 1) {
    actions[i].next_page = actions[i + 1]?.page_url || fallbackUrl;
  }
}

function canonicalAction(label: string): string {
  const compact = String(label || "").trim();
  return compact && compact !== "unknown" ? compact : "unknown_action";
}

function locatorCandidates(label: string, eventType: string, payload?: Record<string, unknown>): Array<Record<string, unknown>> {
  const text = String(label || "").trim();
  const candidates: Array<Record<string, unknown>> = [];

  const coords = payload?.region_bbox && typeof payload.region_bbox === "object"
    ? payload.region_bbox as Record<string, number>
    : undefined;
  if (coords?.region_x_pct !== undefined) {
    candidates.push({
      strategy: "coordinate",
      region: String(payload?.region || "main_content"),
      x_pct: coords.region_x_pct,
      y_pct: coords.region_y_pct,
      w_pct: coords.region_w_pct,
      h_pct: coords.region_h_pct,
      confidence: 0.88,
    });
  }

  const fingerprint = payload?.style_fingerprint
    ? String(payload.style_fingerprint)
    : payload?.computed_styles && typeof payload.computed_styles === "object"
      ? styleFingerprint(payload.computed_styles as Record<string, unknown>)
      : "";
  if (fingerprint) {
    candidates.push({
      strategy: "visual",
      fingerprint,
      hamming_threshold: 12,
      confidence: 0.80,
    });
  }

  const selector = buildSelectorHint(payload);
  if (selector) {
    candidates.push({
      strategy: "css",
      selector,
      confidence: 0.68,
    });
  }

  if (text && text !== "unknown") {
    const action = eventAction(eventType)[0] || "click";
    candidates.push(
      { strategy: "role", role: action === "fill" ? "textbox" : "button", name: text, exact: true, confidence: 0.72 },
      { strategy: "label", text, exact: true, confidence: 0.66 },
      { strategy: "text", text, exact: true, confidence: 0.58 },
    );
  }

  return candidates;
}

function buildSelectorHint(payload?: Record<string, unknown>): string {
  if (!payload) return "";
  const testId = String(payload.data_testid || "").trim();
  if (testId) return `[data-testid="${testId}"]`;
  const elId = String(payload.element_id || "").trim();
  if (elId) return `#${elId}`;
  const role = String(payload.role || "").trim();
  const tag = String(payload.tag || "").trim();
  const className = String(payload.class_name || "").trim();
  if (role && tag) return `${tag}[role="${role}"]`;
  if (className) return `${tag || "*"}.${className.split(" ")[0]}`;
  return "";
}

function parseRegionPartitions(payload: Record<string, unknown>): RegionPartition[] {
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  return regions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const region = normalizeIdentifier(String(row.region || ""), "");
    const widthPct = Number(row.width_pct || 0);
    const heightPct = Number(row.height_pct || 0);
    if (!region || widthPct <= 0 || heightPct <= 0) return [];
    return [{
      region,
      x_pct: clampPct(Number(row.x_pct || 0)),
      y_pct: clampPct(Number(row.y_pct || 0)),
      width_pct: clampPct(widthPct),
      height_pct: clampPct(heightPct),
      confidence: Number(row.confidence || 0.7),
      source: String(row.source || "layout_snapshot"),
      selector_hint: String(row.selector_hint || ""),
      recognition_level: String(row.recognition_level || "medium"),
      recognized_by: Array.isArray(row.recognized_by) ? row.recognized_by.map(String) : [],
      semantic_tags: Array.isArray(row.semantic_tags) ? row.semantic_tags.map(String) : [],
    }];
  });
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function percentBboxFrom(value: unknown, fallback: PercentBbox): PercentBbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const row = value as Record<string, unknown>;
  const width = clampPct(Number(row.width ?? row.w ?? fallback.width));
  const height = clampPct(Number(row.height ?? row.h ?? fallback.height));
  return {
    x: clampPct(Number(row.x ?? fallback.x)),
    y: clampPct(Number(row.y ?? fallback.y)),
    width: width > 0 ? width : fallback.width,
    height: height > 0 ? height : fallback.height,
  };
}

function defaultActionSurfaceBbox(payload: Record<string, unknown>): PercentBbox {
  const x = Number(payload.x_pct || 0);
  const y = Number(payload.y_pct || 0);
  const width = Number(payload.w_pct || 0) || 6;
  const height = Number(payload.h_pct || 0) || 6;
  return {
    x: clampPct(x - width / 2),
    y: clampPct(y - height / 2),
    width: clampPct(width),
    height: clampPct(height),
  };
}

function regionForPoint(partitions: RegionPartition[], fallback: string, xPct: number, yPct: number): string {
  const match = partitions
    .filter((partition) => xPct >= partition.x_pct && xPct <= partition.x_pct + partition.width_pct && yPct >= partition.y_pct && yPct <= partition.y_pct + partition.height_pct)
    .sort((left, right) => right.confidence - left.confidence)[0];
  return match?.region || fallback || "main_content";
}

function mergeRegionPartitions(partitions: RegionPartition[]): RegionPartition[] {
  const byKey = new Map<string, RegionPartition>();
  for (const partition of partitions) {
    const key = `${partition.region}:${Math.round(partition.x_pct)}:${Math.round(partition.y_pct)}:${Math.round(partition.width_pct)}:${Math.round(partition.height_pct)}`;
    const existing = byKey.get(key);
    if (!existing || partition.confidence > existing.confidence) byKey.set(key, partition);
  }
  return [...byKey.values()].sort((left, right) => left.y_pct - right.y_pct || left.x_pct - right.x_pct);
}

function buildHeatZones(pageId: string, clicks: ClickTrace[], partitions: RegionPartition[]): HeatZone[] {
  const clusters: Array<ClickTrace[]> = [];
  const validClicks = clicks.filter((click) => click.x_pct > 0 || click.y_pct > 0);
  for (const click of validClicks) {
    const cluster = clusters.find((rows) => {
      const center = clusterCenter(rows);
      return Math.abs(center.x_pct - click.x_pct) <= 6 && Math.abs(center.y_pct - click.y_pct) <= 6;
    });
    if (cluster) cluster.push(click);
    else clusters.push([click]);
  }
  return clusters
    .sort((left, right) => right.length - left.length)
    .map((cluster, index) => heatZoneFromCluster(pageId, cluster, partitions, index));
}

function clusterCenter(rows: ClickTrace[]): { x_pct: number; y_pct: number } {
  const total = Math.max(1, rows.length);
  return {
    x_pct: rows.reduce((sum, row) => sum + row.x_pct, 0) / total,
    y_pct: rows.reduce((sum, row) => sum + row.y_pct, 0) / total,
  };
}

function heatZoneFromCluster(pageId: string, cluster: ClickTrace[], partitions: RegionPartition[], index: number): HeatZone {
  const center = clusterCenter(cluster);
  const region = regionForPoint(partitions, cluster[0]?.region || "main_content", center.x_pct, center.y_pct);
  const xValues = cluster.map((item) => item.x_pct);
  const yValues = cluster.map((item) => item.y_pct);
  const widthValues = cluster.map((item) => item.w_pct || 0).filter((item) => item > 0);
  const heightValues = cluster.map((item) => item.h_pct || 0).filter((item) => item > 0);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const avgWidth = widthValues.length ? widthValues.reduce((sum, item) => sum + item, 0) / widthValues.length : 6;
  const avgHeight = heightValues.length ? heightValues.reduce((sum, item) => sum + item, 0) / heightValues.length : 6;
  return {
    zone_id: normalizeIdentifier(`zone_${pageId}_${region}_${String(index + 1).padStart(3, "0")}`),
    page_id: pageId,
    region,
    center: {
      x_pct: Math.round(center.x_pct * 100) / 100,
      y_pct: Math.round(center.y_pct * 100) / 100,
    },
    bbox_pct: {
      x: clampPct(Math.min(minX, center.x_pct - avgWidth / 2)),
      y: clampPct(Math.min(minY, center.y_pct - avgHeight / 2)),
      width: clampPct(Math.max(maxX - minX, avgWidth)),
      height: clampPct(Math.max(maxY - minY, avgHeight)),
    },
    event_count: cluster.length,
    action_types: uniqueSorted(cluster.flatMap((click) => eventAction(click.event_type))),
    top_labels: topValues(cluster.map((click) => click.label).filter((label) => label && label !== "unknown"), 5),
    element_ids: uniqueSorted(cluster.map((click) => click.element_id)),
    request_signatures: uniqueSorted(cluster.flatMap((click) => click.request_signatures)),
    evidence_refs: uniqueSorted(cluster.flatMap((click) => click.evidence_refs)),
    confidence: Math.min(0.95, 0.55 + cluster.length * 0.12),
  };
}

function buildSurfaceHeatZones(surfaceId: string, clicks: ClickTrace[]): SurfaceHeatZone[] {
  const clusters: Array<ClickTrace[]> = [];
  const validClicks = clicks.filter((click) => click.surface_bbox.width > 0 && click.surface_bbox.height > 0);
  for (const click of validClicks) {
    const clickCenter = surfaceClickCenter(click);
    const cluster = clusters.find((rows) => {
      const center = surfaceClusterCenter(rows);
      return Math.abs(center.x_pct - clickCenter.x_pct) <= 6 && Math.abs(center.y_pct - clickCenter.y_pct) <= 6;
    });
    if (cluster) cluster.push(click);
    else clusters.push([click]);
  }
  return clusters
    .sort((left, right) => right.length - left.length)
    .map((cluster, index) => surfaceHeatZoneFromCluster(surfaceId, cluster, index));
}

function surfaceClickCenter(click: ClickTrace): { x_pct: number; y_pct: number } {
  return {
    x_pct: clampPct(click.surface_bbox.x + click.surface_bbox.width / 2),
    y_pct: clampPct(click.surface_bbox.y + click.surface_bbox.height / 2),
  };
}

function surfaceClusterCenter(rows: ClickTrace[]): { x_pct: number; y_pct: number } {
  const total = Math.max(1, rows.length);
  const centers = rows.map(surfaceClickCenter);
  return {
    x_pct: centers.reduce((sum, row) => sum + row.x_pct, 0) / total,
    y_pct: centers.reduce((sum, row) => sum + row.y_pct, 0) / total,
  };
}

function surfaceHeatZoneFromCluster(surfaceId: string, cluster: ClickTrace[], index: number): SurfaceHeatZone {
  const center = surfaceClusterCenter(cluster);
  const xValues = cluster.map((item) => item.surface_bbox.x);
  const yValues = cluster.map((item) => item.surface_bbox.y);
  const rightValues = cluster.map((item) => item.surface_bbox.x + item.surface_bbox.width);
  const bottomValues = cluster.map((item) => item.surface_bbox.y + item.surface_bbox.height);
  const minX = Math.min(...xValues);
  const minY = Math.min(...yValues);
  const maxX = Math.max(...rightValues);
  const maxY = Math.max(...bottomValues);
  const region = cluster[0]?.region || "main_content";
  return {
    zone_id: normalizeIdentifier(`surface_zone_${surfaceId}_${region}_${String(index + 1).padStart(3, "0")}`),
    surface_id: surfaceId,
    region,
    center: {
      x_pct: Math.round(center.x_pct * 100) / 100,
      y_pct: Math.round(center.y_pct * 100) / 100,
    },
    bbox_pct: {
      x: clampPct(minX),
      y: clampPct(minY),
      width: clampPct(maxX - minX),
      height: clampPct(maxY - minY),
    },
    event_count: cluster.length,
    action_types: uniqueSorted(cluster.flatMap((click) => eventAction(click.event_type))),
    top_labels: topValues(cluster.map((click) => click.label).filter((label) => label && label !== "unknown"), 5),
    request_signatures: uniqueSorted(cluster.flatMap((click) => click.request_signatures)),
    evidence_refs: uniqueSorted(cluster.flatMap((click) => click.evidence_refs)),
    confidence: Math.min(0.95, 0.55 + cluster.length * 0.12),
  };
}

function buildPageSurfaces(pages: PageMapPage[], clicks: ClickTrace[], pageScreenshots: Map<string, string[]>): PageSurface[] {
  const surfaces: PageSurface[] = [];
  for (const page of pages) {
    const pageClicks = clicks.filter((click) => click.page_url === page.page_url);
    const primaryId = normalizeIdentifier(`primary:${page.page_id}`);
    const primaryClicks = pageClicks.filter((click) => click.surface_kind === "primary_page" || click.surface_id === primaryId);
    const primaryHeatZones = buildSurfaceHeatZones(primaryId, primaryClicks.map((click) => ({
      ...click,
      surface_id: primaryId,
      surface_kind: "primary_page",
      surface_label: "Primary page",
      surface_bbox_in_viewport: { x: 0, y: 0, width: 100, height: 100 },
      surface_bbox: {
        x: clampPct(click.x_pct - (click.w_pct || 6) / 2),
        y: clampPct(click.y_pct - (click.h_pct || 6) / 2),
        width: clampPct(click.w_pct || 6),
        height: clampPct(click.h_pct || 6),
      },
    })));
    surfaces.push({
      surface_id: primaryId,
      surface_kind: "primary_page",
      label: hostFromUrl(page.page_url) || "Primary page",
      page_id: page.page_id,
      page_url: page.page_url,
      surface_bbox_in_viewport: { x: 0, y: 0, width: 100, height: 100 },
      screenshot_refs: (pageScreenshots.get(page.page_url) || []).map((item) => ({ path: item })),
      heat_zones: primaryHeatZones,
      action_count: primaryClicks.length,
      request_count: uniqueSorted(primaryClicks.flatMap((click) => click.request_signatures)).length,
    });

    const secondaryGroups = new Map<string, ClickTrace[]>();
    for (const click of pageClicks) {
      if (click.surface_kind === "primary_page") continue;
      const key = click.surface_id || normalizeIdentifier(`${click.surface_kind}:${page.page_id}:${click.surface_label || click.region}`);
      secondaryGroups.set(key, [...(secondaryGroups.get(key) || []), click]);
    }
    for (const [surfaceId, rows] of secondaryGroups.entries()) {
      const first = rows[0];
      surfaces.push({
        surface_id: surfaceId,
        surface_kind: first.surface_kind,
        label: first.surface_label || first.region || first.surface_kind,
        page_id: page.page_id,
        page_url: page.page_url,
        surface_bbox_in_viewport: first.surface_bbox_in_viewport,
        screenshot_refs: (pageScreenshots.get(page.page_url) || []).map((item) => ({ path: item })),
        heat_zones: buildSurfaceHeatZones(surfaceId, rows),
        action_count: rows.length,
        request_count: uniqueSorted(rows.flatMap((click) => click.request_signatures)).length,
      });
    }
  }
  return surfaces.sort((left, right) => right.action_count - left.action_count || left.surface_kind.localeCompare(right.surface_kind));
}

function topValues(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit).map(([value]) => value);
}

function isBusinessNavRegion(region: string): boolean {
  return ["left_nav", "top_nav", "top_bar", "navigation", "menu"].includes(String(region || ""));
}

function isExitNavigationLabel(label: string): boolean {
  return /返回|退出|关闭|取消|首页|back|home|close|exit/i.test(String(label || ""));
}

function navigationDirection(click: ClickTrace, entryPageId: string): "enter" | "exit" | "move" {
  const nextPageId = pageIdFromUrl(click.next_page || click.page_url);
  if (isExitNavigationLabel(click.label) || nextPageId === entryPageId && click.page_id !== entryPageId) return "exit";
  if (isBusinessNavRegion(click.region)) return "enter";
  return "move";
}

function buildNavigationEdges(run: { system_key: string; entry_url: string; url: string }, clicks: ClickTrace[]): NavigationEdge[] {
  const entryPageId = pageIdFromUrl(run.entry_url || run.url);
  return clicks.flatMap((click) => {
    const toPageId = pageIdFromUrl(click.next_page || click.page_url);
    const pageChanged = toPageId !== click.page_id;
    const isNavigation = isBusinessNavRegion(click.region) || pageChanged || isExitNavigationLabel(click.label);
    if (!isNavigation) return [];
    const direction = navigationDirection(click, entryPageId);
    const moduleId = direction === "enter" && !isExitNavigationLabel(click.label) ? normalizeIdentifier(`${run.system_key}:${canonicalAction(click.label)}`) : "";
    return [{
      edge_id: normalizeIdentifier(`nav_${run.system_key}_${click.page_id}_${toPageId}_${click.action_id}`),
      direction,
      from_page_id: click.page_id,
      to_page_id: toPageId,
      action_id: click.action_id,
      label: click.label,
      element_id: click.element_id,
      source_region: click.region,
      module_id: moduleId,
      evidence_refs: click.evidence_refs,
      confidence: pageChanged ? 0.86 : 0.72,
      priority: direction === "enter" || direction === "exit" ? 100 : 70,
    }];
  }).sort((left, right) => right.priority - left.priority || left.action_id.localeCompare(right.action_id));
}

function buildBusinessCatalog(run: { system_key: string; entry_url: string; url: string }, clicks: ClickTrace[], pages: PageMapPage[], navigationEdges: NavigationEdge[]): BusinessCatalogArtifact {
  const modules = new Map<string, BusinessCatalogModule>();
  for (const click of clicks) {
    if (!isBusinessNavRegion(click.region)) continue;
    const title = canonicalAction(click.label);
    if (!title || title === "unknown_action" || isExitNavigationLabel(title)) continue;
    const moduleId = normalizeIdentifier(`${run.system_key}:${title}`);
    const page = pages.find((item) => item.page_id === click.page_id);
    const moduleNavigationEdges = navigationEdges.filter((edge) => edge.module_id === moduleId || edge.label === click.label);
    const exitEdges = navigationEdges.filter((edge) => edge.direction === "exit" && [click.page_id, ...moduleNavigationEdges.map((edge) => edge.to_page_id)].includes(edge.from_page_id));
    const heatZoneIds = (page?.heat_zones || [])
      .filter((zone) => zone.element_ids.includes(click.element_id) || zone.top_labels.includes(click.label))
      .map((zone) => zone.zone_id);
    const relatedPages = uniqueSorted([click.page_id, ...moduleNavigationEdges.flatMap((edge) => [edge.from_page_id, edge.to_page_id])]);
    const existing = modules.get(moduleId);
    const action = {
      action_id: click.action_id,
      label: click.label,
      page_id: click.page_id,
      element_id: click.element_id,
      request_signatures: click.request_signatures,
      evidence_refs: click.evidence_refs,
    };
    if (existing) {
      existing.pages = uniqueSorted([...existing.pages, ...relatedPages]);
      existing.element_ids = uniqueSorted([...existing.element_ids, click.element_id]);
      existing.heat_zone_ids = uniqueSorted([...existing.heat_zone_ids, ...heatZoneIds]);
      existing.request_signatures = uniqueSorted([...existing.request_signatures, ...click.request_signatures]);
      existing.actions = dedupeBy([...existing.actions, action], (item) => `${item.page_id}:${item.label}:${item.element_id}`);
      existing.entry_actions = dedupeBy([...existing.entry_actions, ...moduleNavigationEdges.filter((edge) => edge.direction === "enter")], (item) => item.edge_id);
      existing.exit_actions = dedupeBy([...existing.exit_actions, ...exitEdges], (item) => item.edge_id);
      existing.evidence_refs = uniqueSorted([...existing.evidence_refs, ...click.evidence_refs]);
      existing.confidence = Math.min(0.95, existing.confidence + 0.06);
    } else {
      modules.set(moduleId, {
        module_id: moduleId,
        title,
        level: 1,
        parent_module_id: "",
        source_region: click.region,
        pages: relatedPages,
        element_ids: click.element_id ? [click.element_id] : [],
        heat_zone_ids: uniqueSorted(heatZoneIds),
        request_signatures: click.request_signatures,
        actions: [action],
        entry_actions: moduleNavigationEdges.filter((edge) => edge.direction === "enter"),
        exit_actions: exitEdges,
        evidence_refs: click.evidence_refs,
        confidence: 0.74,
      });
    }
  }
  const rows = [...modules.values()].sort((left, right) => right.actions.length - left.actions.length || left.title.localeCompare(right.title));
  return {
    generated_at: utcNowIso(),
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "business_catalog",
    source_system: run.system_key,
    source_url: run.entry_url || run.url,
    modules: rows,
    navigation_edges: navigationEdges,
    confidence: rows.length ? 0.76 : 0.45,
  };
}

export async function finalizeCapture(store: KnowledgeStore, runId: string, llmConfig?: LLMConfig): Promise<{
  evidenceIndex: EvidenceIndexArtifact;
  pageMap: PageMapArtifact;
  businessCatalog: BusinessCatalogArtifact;
  elementMap: ElementMapArtifact;
  requestCatalog: RequestCatalogArtifact;
  actionTrace: ActionTraceArtifact;
  semanticAnnotations: SemanticAnnotationsArtifact;
  actionRules: ActionRulesArtifact;
  recipePack: RecipePack;
}> {
  const run = await store.loadRun(runId);
  const rawEvents = await store.loadEvents(runId);
  const events = rawEvents.map((item) => CaptureEventSchema.parse(item));
  if (events.length === 0) throw new Error(`no capture events found for ${runId}`);

  const now = utcNowIso();
  const learningScope = learningScopeFromRun(run);
  const urlHistory: string[] = [];
  const pageElements = new Map<string, Map<string, ElementAsset>>();
  const pageLayoutRegions = new Map<string, RegionPartition[]>();
  const pageScreenshots = new Map<string, string[]>();
  const requestMap = new Map<string, RequestRecordDraft>();
  const clicks: ClickTrace[] = [];
  let latestUrl = run.current_url || run.url;
  let latestLearnedUrl = run.entry_url || run.url;

  events.forEach((event, index) => {
    const type = event.event_type.toLowerCase();
    const payload = event.payload || {};
    const pageUrl = eventUrl(event) || latestUrl || run.url;
    const pageInScope = urlInLearningScope(pageUrl, learningScope);
    const eventTs = event.ts || now;
    const eventTsMs = tsMs(eventTs, index + 1);
    if (pageUrl) {
      latestUrl = pageUrl;
      if (pageInScope) {
        latestLearnedUrl = pageUrl;
        if (!urlHistory.includes(pageUrl)) urlHistory.push(pageUrl);
      }
    }

    if (type.startsWith("visual_snapshot")) {
      if (!pageInScope) return;
      const ref = String(payload.storage_ref || payload.path || payload.image_path || "").trim();
      if (ref) {
        const list = pageScreenshots.get(pageUrl) || [];
        list.push(ref);
        pageScreenshots.set(pageUrl, list);
      }
    }

    if (type === "layout_snapshot") {
      if (!pageInScope) return;
      const regions = parseRegionPartitions(payload);
      if (regions.length) {
        const existing = pageLayoutRegions.get(pageUrl) || [];
        pageLayoutRegions.set(pageUrl, mergeRegionPartitions([...existing, ...regions]));
      }
    }

    if (["ui_click", "ui_input", "ui_change", "ui_submit", "ui_state_change", "ui_pointer_start", "ui_pointer_end", "ui_keydown", "ui_select"].includes(type)) {
      if (!pageInScope) return;
      const directText = String(payload.direct_text || "").trim();
      const label = directText || String(payload.label || payload.text || payload.aria_label || "unknown").trim() || "unknown";
      const region = String(payload.region || "").trim() || inferRegion(payload);
      const regionBbox = payload.region_bbox && typeof payload.region_bbox === "object"
        ? payload.region_bbox as Record<string, number>
        : undefined;
      const styles = payload.computed_styles && typeof payload.computed_styles === "object"
        ? payload.computed_styles as Record<string, unknown>
        : undefined;
      const pageId = pageIdFromUrl(pageUrl);
      const primarySurfaceId = normalizeIdentifier(`primary:${pageId}`);
      const rawSurfaceKind = String(payload.surface_kind || "primary_page");
      const surfaceKind: PageSurface["surface_kind"] = rawSurfaceKind === "secondary_surface" || rawSurfaceKind === "child_window_surface"
        ? rawSurfaceKind
        : "primary_page";
      const surfaceId = normalizeIdentifier(String(payload.surface_id || primarySurfaceId), primarySurfaceId);
      const surfaceBboxInViewport = surfaceKind === "primary_page"
        ? { x: 0, y: 0, width: 100, height: 100 }
        : percentBboxFrom(payload.surface_bbox_in_viewport, { x: 0, y: 0, width: 100, height: 100 });
      const surfaceBbox = percentBboxFrom(payload.surface_bbox, defaultActionSurfaceBbox(payload));
      const elementId = stableElementId({
        systemKey: run.system_key,
        pageUrl,
        region,
        eventType: type,
        regionBbox,
        xPct: Number(payload.x_pct || 0),
        yPct: Number(payload.y_pct || 0),
      });
      const eventRef = `event:${index}`;
      const bucket = pageElements.get(pageUrl) || new Map<string, ElementAsset>();
      const key = elementId;
      const existing = bucket.get(key);
      const actions = new Set([...(existing?.action_types || []), ...eventAction(type)]);
      bucket.set(key, {
        element_id: elementId,
        page_id: pageId,
        label,
        selector: buildSelectorHint(payload),
        role: String(payload.role || "").trim(),
        text: String(payload.text || label).trim(),
        aria_label: String(payload.aria_label || "").trim(),
        direct_text: directText,
        action_types: [...actions].sort(),
        region,
        confidence: existing ? Math.max(existing.confidence, 0.85) : 0.82,
        style_fingerprint: styles ? styleFingerprint(styles) : "",
        region_bbox: regionBbox || {},
        bbox: {
          x: Number(payload.x || 0),
          y: Number(payload.y || 0),
          width: Number(payload.width || 0),
          height: Number(payload.height || 0),
          x_pct: Number(payload.x_pct || 0),
          y_pct: Number(payload.y_pct || 0),
        },
        locator_candidates: locatorCandidates(label, type, payload),
        evidence_refs: uniqueSorted([...(existing?.evidence_refs || []), eventRef]),
      });
      pageElements.set(pageUrl, bucket);
      clicks.push({
        action_id: `action_${String(clicks.length + 1).padStart(3, "0")}`,
        ts: eventTs,
        ts_ms: eventTsMs,
        page_url: pageUrl,
        page_id: pageIdFromUrl(pageUrl),
        element_id: elementId,
        region,
        label,
        event_type: type,
        request_signatures: [],
        next_page: "",
        evidence_refs: [eventRef],
        x_pct: Number(payload.x_pct || 0),
        y_pct: Number(payload.y_pct || 0),
        w_pct: Number(payload.w_pct || 0),
        h_pct: Number(payload.h_pct || 0),
        surface_id: surfaceId,
        surface_kind: surfaceKind,
        surface_label: String(payload.surface_label || "").trim(),
        surface_bbox: surfaceBbox,
        surface_bbox_in_viewport: surfaceBboxInViewport,
        region_bbox: regionBbox || {},
        style_fingerprint: styles ? styleFingerprint(styles) : "",
        direct_text: directText,
        tag: String(payload.tag || "").trim(),
        role: String(payload.role || "").trim(),
      });
    }

    if (["network_completed", "network_request", "network_response"].includes(type)) {
      const rawUrl = String(payload.url || event.url || "").trim();
      if (!rawUrl) return;
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return;
      }
      if (!pageInScope || !urlInLearningScope(rawUrl, learningScope)) return;
      const method = String(payload.method || "GET").toUpperCase();
      const resourceType = String(payload.resource_type || "").toLowerCase();
      const pathTemplate = normalizePathTemplate(parsed.pathname || "/");
      const qKeys = [...new Set([...parsed.searchParams.keys()])].sort();
      const { bodyKeys, bodySample, bodyFormat } = bodySummary(payload);
      const bodyFingerprint = bodyKeys.length ? hashObject(bodyKeys) : "none";
      const statusCode = Number(payload.status_code || 0);
      const signature = `${method}:${pathTemplate}:${qKeys.join(",")}:${bodyFingerprint}:${statusCode}`;
      const classification = classifyRequest(parsed, resourceType);
      const latency = Number(payload.latency_ms || payload.duration_ms || 0);
      const occurrence = Math.max(1, Number(payload.occurrence_count || 1));
      const existing = requestMap.get(signature);
      if (existing) {
        existing.occurrence += occurrence;
        existing.latency_avg_ms = Math.round(((existing.latency_avg_ms + latency) / 2) * 100) / 100;
        existing.latency_p95_ms = Math.max(existing.latency_p95_ms, latency);
        existing.page_urls.add(pageUrl);
        if (!existing.page_url) {
          existing.page_url = pageUrl;
          existing.page_id = pageIdFromUrl(pageUrl);
        }
        if (statusCode > 0) existing.status_codes.add(statusCode);
      } else {
        requestMap.set(signature, {
          signature,
          method,
          host: parsed.hostname.toLowerCase(),
          path_template: pathTemplate,
          sample_url: rawUrl,
          page_id: pageIdFromUrl(pageUrl),
          page_url: pageUrl,
          query_keys: qKeys,
          query_sample: querySample(parsed),
          body_keys: bodyKeys,
          body_sample: bodySample,
          body_key_fingerprint: bodyFingerprint,
          body_format: bodyFormat,
          status_code: statusCode,
          occurrence,
          latency_p95_ms: latency,
          latency_avg_ms: latency,
          is_effective: classification.effective,
          effective_reason: classification.reason,
          request_category: classification.category,
          page_urls: new Set([pageUrl]),
          status_codes: statusCode > 0 ? new Set([statusCode]) : new Set(),
        });
      }
      // Prefer interaction_ref marker over time-window heuristic
      const interactionRef = payload.interaction_ref as { element_id?: string; type?: string; ts?: number } | undefined;
      let attributed = false;
      if (interactionRef?.element_id) {
        const refClick = [...clicks].reverse().find((click) => click.element_id === interactionRef.element_id);
        if (refClick && !refClick.request_signatures.includes(signature)) {
          refClick.request_signatures.push(signature);
          attributed = true;
        }
      }
      if (!attributed) {
        const nearest = [...clicks].reverse().find((click) => click.page_url === pageUrl && eventTsMs >= click.ts_ms && eventTsMs - click.ts_ms <= 8000);
        if (nearest && !nearest.request_signatures.includes(signature)) nearest.request_signatures.push(signature);
      }
    }
  });

  assignNextPages(clicks, latestLearnedUrl);
  const recordedActions = dropDuplicateSubmitActions(dropTextFocusActions(foldTextEntryActions(clicks)));
  assignNextPages(recordedActions, latestLearnedUrl);

  const requests = [...requestMap.values()]
    .map(({ page_urls: pageUrls, status_codes: _codes, ...record }) => {
      const urls = [...pageUrls].filter(Boolean);
      const primaryPageUrl = record.page_url || urls[0] || "";
      return {
        ...record,
        page_url: primaryPageUrl,
        page_id: record.page_id || (primaryPageUrl ? pageIdFromUrl(primaryPageUrl) : ""),
        page_urls: urls,
      };
    })
    .sort((a, b) => b.occurrence - a.occurrence);
  const allElements = [...pageElements.values()].flatMap((bucket) => [...bucket.values()]);
  const pages: PageMapPage[] = [...new Set([run.entry_url || run.url, ...urlHistory])]
    .filter((pageUrl) => Boolean(pageUrl) && urlInLearningScope(pageUrl, learningScope))
    .map((pageUrl) => {
    const elements = [...(pageElements.get(pageUrl)?.values() || [])];
    const pageId = pageIdFromUrl(pageUrl);
    const regionPartitions = pageLayoutRegions.get(pageUrl) || [];
    const pageClicks = recordedActions.filter((click) => click.page_url === pageUrl);
    const heatZones = buildHeatZones(pageId, pageClicks, regionPartitions);
    const pageRequests = [...requestMap.values()]
      .filter((request) => request.page_urls.has(pageUrl))
      .map((request) => ({
        signature: request.signature,
        method: request.method,
        host: request.host,
        path_template: request.path_template,
        request_category: request.request_category,
        occurrence: request.occurrence,
        latency_avg_ms: request.latency_avg_ms,
        latency_p95_ms: request.latency_p95_ms,
        query_keys: request.query_keys,
        body_keys: request.body_keys,
        status_codes: [...request.status_codes].sort(),
      }));
    return {
      page_url: pageUrl,
      page_id: pageId,
      entry_url: run.entry_url || run.url,
      page_host: hostFromUrl(pageUrl),
      screenshot_refs: (pageScreenshots.get(pageUrl) || []).map((item) => ({ path: item })),
      regions: uniqueSorted([...elements.map((item) => item.region), ...regionPartitions.map((item) => item.region), ...heatZones.map((item) => item.region)]),
      region_partitions: regionPartitions,
      heat_zones: heatZones,
      request_count: pageRequests.reduce((sum, item) => sum + item.occurrence, 0),
      param_hotspots: uniqueSorted(pageRequests.flatMap((item) => [...item.query_keys, ...item.body_keys])).slice(0, 16),
      state_slices: [],
      evidence_refs: uniqueSorted([...elements.flatMap((item) => item.evidence_refs), ...heatZones.flatMap((item) => item.evidence_refs)]),
      page_type: "other" as const,
      page_description: "",
    };
  });
  const sortedPages = pages.sort((a, b) => b.request_count - a.request_count);
  const surfaces = buildPageSurfaces(sortedPages, recordedActions, pageScreenshots);

  const evidenceIndex: EvidenceIndexArtifact = {
    generated_at: now,
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "evidence_index",
    system_key: run.system_key,
    run_id: runId,
    raw_event_count: events.length,
    events: events.map((event, index) => ({
      evidence_id: `event:${index}`,
      event_type: event.event_type,
      ts: event.ts || "",
      page_url: eventUrl(event),
    })),
    screenshots: [...pageScreenshots.entries()].flatMap(([pageUrl, refs]) => refs.map((ref) => ({
      page_url: pageUrl,
      ref,
    }))),
  };

  const pageMap: PageMapArtifact = {
    generated_at: now,
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "page_map",
    source_system: run.system_key,
    source_url: run.entry_url || run.url,
    url_history: urlHistory,
    pages: sortedPages,
    surfaces,
    navigation_edges: buildNavigationEdges(run, recordedActions),
    confidence: allElements.length ? 0.82 : 0.55,
  };

  const businessCatalog = buildBusinessCatalog(run, recordedActions, pageMap.pages, pageMap.navigation_edges);

  const elementMap: ElementMapArtifact = {
    generated_at: now,
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "element_map",
    source_system: run.system_key,
    source_url: run.entry_url || run.url,
    elements: allElements.sort((a, b) => `${a.page_id}:${a.region}:${a.label}`.localeCompare(`${b.page_id}:${b.region}:${b.label}`)),
    confidence: allElements.length ? 0.82 : 0.55,
  };

  const requestCatalog: RequestCatalogArtifact = {
    generated_at: now,
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "request_catalog",
    source_system: run.system_key,
    source_url: run.entry_url || run.url,
    requests,
    grouped_requests: Object.values(requests.reduce<Record<string, { group_key: string; request_signatures: string[]; total_occurrence: number; avg_latency_ms: number }>>((acc, request) => {
      const key = `${request.method}:${request.path_template}`;
      const row = acc[key] || { group_key: key, request_signatures: [], total_occurrence: 0, avg_latency_ms: 0 };
      row.request_signatures.push(request.signature);
      row.total_occurrence += request.occurrence;
      row.avg_latency_ms = Math.round(((row.avg_latency_ms + request.latency_avg_ms) / 2) * 100) / 100;
      acc[key] = row;
      return acc;
    }, {})).sort((a, b) => b.total_occurrence - a.total_occurrence),
    filters: { exclude_static: true, exclude_tracking: false, include_resource_types: ["xhr", "fetch"], source: "desktop_client" },
    summary: {
      captured_total: events.length,
      kept: requests.length,
      effective_requests: requests.filter((item) => item.is_effective).length,
      business_occurrence_total: requests.filter((item) => item.request_category === "business").reduce((sum, item) => sum + item.occurrence, 0),
      tracking_occurrence_total: requests.filter((item) => item.request_category === "tracking").reduce((sum, item) => sum + item.occurrence, 0),
      source: "desktop_client",
    },
  };

  const actionTraceSteps: ActionTraceStep[] = recordedActions.map((click) => ({
    action_id: `${runId}_${click.action_id}`,
    ts: click.ts,
    ts_ms: click.ts_ms,
    page_url: click.page_url,
    page_id: click.page_id,
    element_id: click.element_id,
    region: click.region,
    label: click.label,
    event_type: click.event_type,
    request_signatures: click.request_signatures,
    x_pct: click.x_pct,
    y_pct: click.y_pct,
    w_pct: click.w_pct,
    h_pct: click.h_pct,
    surface_id: click.surface_id,
    surface_kind: click.surface_kind,
    surface_label: click.surface_label,
    surface_bbox: click.surface_bbox,
    surface_bbox_in_viewport: click.surface_bbox_in_viewport,
    next_page_url: click.next_page || click.page_url,
    next_page_id: pageIdFromUrl(click.next_page || click.page_url),
    evidence_refs: click.evidence_refs,
  }));

  const actionTrace: ActionTraceArtifact = {
    generated_at: now,
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "action_trace",
    system_key: run.system_key,
    run_id: runId,
    actions: actionTraceSteps,
  };

  const semanticAnnotations: SemanticAnnotationsArtifact = {
    generated_at: now,
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "semantic_annotations",
    system_key: run.system_key,
    run_id: runId,
    model: "",
    annotations: [],
  };

  const rules: ActionRule[] = recordedActions.map((click) => ({
    rule_id: `${runId}_${click.action_id}`,
    canonical_action: canonicalAction(click.label),
    entry_page: pageIdFromUrl(run.entry_url || run.url),
    current_page: click.page_id,
    target_element_id: click.element_id,
    effect: `${click.region}:${canonicalAction(click.label)}`,
    next_page: pageIdFromUrl(click.next_page || click.page_url),
    risk_level: "low",
    requires_human_gate: false,
    preconditions: [`page:${click.page_id}`, click.element_id ? `element:${click.element_id}` : ""].filter(Boolean),
    success_criteria: [
      ...(click.next_page && click.next_page !== click.page_url ? [`url -> ${normalizePathTemplate(new URL(click.next_page).pathname)}`] : []),
      ...click.request_signatures.slice(0, 3).map((signature) => `request:${signature}`),
    ],
    evidence_refs: click.evidence_refs,
    confidence: click.request_signatures.length ? 0.78 : 0.62,
  }));

  const actionRules: ActionRulesArtifact = {
    generated_at: now,
    schema_version: "v1",
    producer: "autorecipe-ts",
    artifact_type: "action_rules",
    source_system: run.system_key,
    source_url: run.entry_url || run.url,
    actions: recordedActions.map((click) => ({
      action_id: `${runId}_${click.action_id}`,
      ui_action: click.label,
      canonical_action: canonicalAction(click.label),
      element_id: click.element_id,
      confidence: 0.7,
    })),
    rules,
    risk_policy: {},
  };

  const recipePack: RecipePack = {
    schema_version: "v1",
    artifact_type: "recipe_pack",
    system_key: run.system_key,
    recipe_id: "captured_flow",
    title: "Captured desktop flow",
    description: "Generated from Electron desktop capture events.",
    entry_pages: [pageIdFromUrl(run.entry_url || run.url)],
    steps: recordedActions.map((click) => ({
      action: click.event_type === "ui_input" || click.event_type === "ui_change" || click.event_type === "ui_select"
        ? "fill_text"
        : click.event_type === "ui_submit"
          ? "submit_form"
          : click.event_type === "ui_pointer_start" || click.event_type === "ui_pointer_end"
            ? "drag_text"
            : click.event_type === "ui_keydown"
              ? "key_press"
              : "click_text",
      page: click.page_id,
      element_id: click.element_id,
      region: click.region,
      text: click.label === "unknown" ? "" : click.label,
      text_mode: click.label === "unknown" ? "derived" : "exact_text",
      semantic_action: canonicalAction(click.label),
      target_type: "action",
      locator_candidates: locatorCandidates(click.direct_text || click.label, click.event_type, {
        region: click.region,
        region_bbox: click.region_bbox,
        style_fingerprint: click.style_fingerprint,
        data_testid: "",
        element_id: click.element_id,
        role: "",
        tag: "",
        class_name: "",
      }),
      assert_next_page: click.next_page ? pageIdFromUrl(click.next_page) : "",
      success_criteria: click.request_signatures.map((signature) => `request:${signature}`),
    })),
    playwright_recipe: { steps: [] },
    success_criteria: rules.flatMap((flow) => flow.success_criteria),
    matched_requests: requests.slice(0, 24),
    summary: { replay_step_count: recordedActions.length, matched_request_count: requests.length },
  };
  recipePack.playwright_recipe = { steps: recipePack.steps };

  const summary = {
    generated_at: now,
    schema_version: "v1",
    artifact_type: "mining_run_summary",
    run_id: run.run_id,
    system_key: run.system_key,
    source_url: run.entry_url || run.url,
    status: "finalized",
    counts: {
      events: events.length,
      pages: pageMap.pages.length,
      navigation_edges: pageMap.navigation_edges.length,
      business_modules: businessCatalog.modules.length,
      elements: elementMap.elements.length,
      interactives: elementMap.elements.length,
      requests: requestCatalog.requests.length,
      business_requests: requestCatalog.requests.filter((item) => item.request_category === "business").length,
      actions: actionTrace.actions.length,
      rules: actionRules.rules.length,
      recipe_steps: recipePack.steps.length,
      heat_zones: pageMap.pages.reduce((sum, page) => sum + page.heat_zones.length, 0),
      surfaces: pageMap.surfaces.length,
    },
    artifacts: {
      evidence_index: "artifacts/evidence_index.json",
      page_map: "artifacts/page_map.json",
      business_catalog: "artifacts/business_catalog.json",
      element_map: "artifacts/element_map.json",
      request_catalog: "artifacts/request_catalog.json",
      action_trace: "artifacts/action_trace.json",
      semantic_annotations: "artifacts/semantic_annotations.json",
      action_rules: "artifacts/action_rules.json",
      recipe_pack: "artifacts/recipe_pack.json",
    },
  };
  // Semantic enrichment (B2 page classification + B1 module annotations)
  if (llmConfig?.apiKey) {
    try {
      const enrichment = await enrichWithSemanticData(llmConfig, {
        pageMap,
        businessCatalog,
        pageScreenshots,
        readFileAsBase64: async (filePath: string) => {
          try {
            const abs = filePath.startsWith("/") ? filePath : path.join(store.runDir(runId), filePath);
            const buf = await readFile(abs);
            return buf.toString("base64");
          } catch {
            return undefined;
          }
        },
      });
      applyEnrichmentToArtifacts(enrichment, pageMap, semanticAnnotations);
    } catch (error) {
      console.warn("[finalizeCapture] semantic enrichment failed, continuing without:", error);
    }
  }
  await store.saveArtifact(runId, "evidence_index", evidenceIndex);
  await store.saveArtifact(runId, "page_map", pageMap);
  await store.saveArtifact(runId, "business_catalog", businessCatalog);
  await store.saveArtifact(runId, "element_map", elementMap);
  await store.saveArtifact(runId, "request_catalog", requestCatalog);
  await store.saveArtifact(runId, "action_trace", actionTrace);
  await store.saveArtifact(runId, "semantic_annotations", semanticAnnotations);
  await store.saveArtifact(runId, "action_rules", actionRules);
  await store.saveArtifact(runId, "recipe_pack", recipePack);
  await store.saveArtifact(runId, "summary", summary);
  await store.saveRun({ ...run, current_url: latestUrl, latest_assets: {
    evidence_index: store.artifactPath(runId, "evidence_index"),
    page_map: store.artifactPath(runId, "page_map"),
    business_catalog: store.artifactPath(runId, "business_catalog"),
    element_map: store.artifactPath(runId, "element_map"),
    request_catalog: store.artifactPath(runId, "request_catalog"),
    action_trace: store.artifactPath(runId, "action_trace"),
    semantic_annotations: store.artifactPath(runId, "semantic_annotations"),
    action_rules: store.artifactPath(runId, "action_rules"),
    recipe_pack: store.artifactPath(runId, "recipe_pack"),
    summary: store.artifactPath(runId, "summary"),
  } });
  await store.writeRunManifest({ ...run, current_url: latestUrl, latest_assets: {
    evidence_index: store.artifactPath(runId, "evidence_index"),
    page_map: store.artifactPath(runId, "page_map"),
    business_catalog: store.artifactPath(runId, "business_catalog"),
    element_map: store.artifactPath(runId, "element_map"),
    request_catalog: store.artifactPath(runId, "request_catalog"),
    action_trace: store.artifactPath(runId, "action_trace"),
    semantic_annotations: store.artifactPath(runId, "semantic_annotations"),
    action_rules: store.artifactPath(runId, "action_rules"),
    recipe_pack: store.artifactPath(runId, "recipe_pack"),
    summary: store.artifactPath(runId, "summary"),
  } }, { status: "finalized", summary: summary.counts });
  return { evidenceIndex, pageMap, businessCatalog, elementMap, requestCatalog, actionTrace, semanticAnnotations, actionRules, recipePack };
}

export async function mergeSystem(store: KnowledgeStore, systemKey: string, llmConfig?: LLMConfig): Promise<{ systemDir: string; runCount: number; packPath: string }> {
  const runs = await store.listRuns(systemKey);
  const eligibleRuns: typeof runs = [];
  for (const run of runs) {
    if (await shouldMergeRun(store, run)) eligibleRuns.push(run);
  }
  const systemDir = store.systemDir(systemKey);
  const pageMaps: PageMapArtifact[] = [];
  const businessCatalogs: BusinessCatalogArtifact[] = [];
  const elementMaps: ElementMapArtifact[] = [];
  const semanticAnnotations: SemanticAnnotationsArtifact[] = [];
  const actionRuleArtifacts: ActionRulesArtifact[] = [];
  const requests: RequestRecord[] = [];
  for (const run of eligibleRuns) {
    try {
      pageMaps.push(await store.loadArtifact<PageMapArtifact>(run.run_id, "page_map"));
      businessCatalogs.push(await store.loadArtifact<BusinessCatalogArtifact>(run.run_id, "business_catalog"));
      elementMaps.push(await store.loadArtifact<ElementMapArtifact>(run.run_id, "element_map"));
      semanticAnnotations.push(await store.loadArtifact<SemanticAnnotationsArtifact>(run.run_id, "semantic_annotations"));
      actionRuleArtifacts.push(await store.loadArtifact<ActionRulesArtifact>(run.run_id, "action_rules"));
      const catalog = await store.loadArtifact<RequestCatalogArtifact>(run.run_id, "request_catalog");
      requests.push(...catalog.requests);
    } catch {
      // Skip runs that have not been finalized yet.
    }
  }
  await mkdir(path.join(systemDir, "knowledge"), { recursive: true });
  await mkdir(path.join(systemDir, "actions", "recipe_packs"), { recursive: true });
  const pageMap = {
    generated_at: utcNowIso(),
    artifact_type: "page_map",
    system_key: systemKey,
    pages: mergePageMapPages(pageMaps.flatMap((item) => item.pages)),
    surfaces: mergePageSurfaces(pageMaps.flatMap((item) => item.surfaces || [])),
    navigation_edges: dedupeBy(pageMaps.flatMap((item) => item.navigation_edges || []), (item) => item.edge_id),
    url_history: uniqueSorted(pageMaps.flatMap((item) => item.url_history)),
  };
  const elementMap = {
    generated_at: utcNowIso(),
    artifact_type: "element_map",
    system_key: systemKey,
    elements: dedupeBy(elementMaps.flatMap((item) => item.elements), (item) => item.element_id),
  };
  const businessCatalog = {
    generated_at: utcNowIso(),
    artifact_type: "business_catalog",
    system_key: systemKey,
    modules: mergeBusinessModules(businessCatalogs.flatMap((item) => item.modules)),
    navigation_edges: dedupeBy(businessCatalogs.flatMap((item) => item.navigation_edges || []), (item) => item.edge_id),
  };
  const semanticCatalog = {
    generated_at: utcNowIso(),
    artifact_type: "semantic_annotations",
    system_key: systemKey,
    annotations: semanticAnnotations.flatMap((item) => item.annotations),
  };
  const actionRulesCatalog = {
    generated_at: utcNowIso(),
    artifact_type: "action_rules",
    system_key: systemKey,
    actions: actionRuleArtifacts.flatMap((item) => item.actions),
    rules: dedupeBy(actionRuleArtifacts.flatMap((item) => item.rules), (item) => item.rule_id),
  };
  const requestCatalog = {
    generated_at: utcNowIso(),
    artifact_type: "request_catalog",
    system_key: systemKey,
    requests: dedupeBy(requests, (item) => item.signature),
  };
  const latestPack = [...eligibleRuns].reverse().find((run) => run.latest_assets.recipe_pack);
  const pack = latestPack ? await store.loadArtifact<RecipePack>(latestPack.run_id, "recipe_pack") : {
    schema_version: "v1",
    artifact_type: "recipe_pack" as const,
    system_key: systemKey,
    recipe_id: "captured_flow",
    title: "Captured desktop flow",
    steps: [],
    playwright_recipe: { steps: [] },
  };
  const packPath = path.join(systemDir, "actions", "recipe_packs", "captured_flow.json");
  await writeFile(path.join(systemDir, "knowledge", "page_map.json"), JSON.stringify(pageMap, null, 2), "utf8");
  await writeFile(path.join(systemDir, "knowledge", "business_catalog.json"), JSON.stringify(businessCatalog, null, 2), "utf8");
  await writeFile(path.join(systemDir, "knowledge", "element_map.json"), JSON.stringify(elementMap, null, 2), "utf8");
  await writeFile(path.join(systemDir, "knowledge", "request_catalog.json"), JSON.stringify(requestCatalog, null, 2), "utf8");
  await writeFile(path.join(systemDir, "knowledge", "semantic_annotations.json"), JSON.stringify(semanticCatalog, null, 2), "utf8");
  await writeFile(path.join(systemDir, "actions", "action_rules.json"), JSON.stringify(actionRulesCatalog, null, 2), "utf8");
  await writeFile(packPath, JSON.stringify(pack, null, 2), "utf8");
  await writeFile(path.join(systemDir, "actions", "index.json"), JSON.stringify({
    generated_at: utcNowIso(),
    artifact_type: "recipe_pack_index",
    system_key: systemKey,
    capabilities: { replayable_recipe_ids: ["captured_flow"] },
    recipes: [{ recipe_id: "captured_flow", title: pack.title, file: "recipe_packs/captured_flow.json" }],
  }, null, 2), "utf8");
  await store.writeSystemMetadata(systemKey, { runCount: eligibleRuns.length, packPath, runs: eligibleRuns });

  const operationManual = await synthesizeCapabilities(systemKey, businessCatalog, actionRulesCatalog, pageMap, eligibleRuns.map((r) => r.run_id), llmConfig);
  await writeFile(path.join(systemDir, "knowledge", "operation_manual.json"), JSON.stringify(operationManual, null, 2), "utf8");

  return { systemDir, runCount: eligibleRuns.length, packPath };
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const out = new Map<string, T>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key || out.has(key)) continue;
    out.set(key, item);
  }
  return [...out.values()];
}

function mergePageMapPages(pages: PageMapPage[]): PageMapPage[] {
  const grouped = new Map<string, PageMapPage[]>();
  for (const page of pages) {
    const rows = grouped.get(page.page_id) || [];
    rows.push(page);
    grouped.set(page.page_id, rows);
  }
  return [...grouped.values()].map((rows) => {
    const first = rows[0];
    const heatZones = mergeHeatZones(rows.flatMap((page) => page.heat_zones || []));
    return {
      ...first,
      screenshot_refs: rows.flatMap((page) => page.screenshot_refs || []),
      regions: uniqueSorted(rows.flatMap((page) => page.regions || [])),
      region_partitions: mergeRegionPartitions(rows.flatMap((page) => page.region_partitions || [])),
      heat_zones: heatZones,
      request_count: rows.reduce((sum, page) => sum + Number(page.request_count || 0), 0),
      param_hotspots: uniqueSorted(rows.flatMap((page) => page.param_hotspots || [])).slice(0, 16),
      state_slices: rows.flatMap((page) => page.state_slices || []),
      evidence_refs: uniqueSorted(rows.flatMap((page) => page.evidence_refs || [])),
    };
  }).sort((left, right) => right.request_count - left.request_count);
}

function mergePageSurfaces(surfaces: PageSurface[]): PageSurface[] {
  const grouped = new Map<string, PageSurface[]>();
  for (const surface of surfaces) {
    const rows = grouped.get(surface.surface_id) || [];
    rows.push(surface);
    grouped.set(surface.surface_id, rows);
  }
  return [...grouped.values()].map((rows) => {
    const first = rows[0];
    return {
      ...first,
      screenshot_refs: rows.flatMap((surface) => surface.screenshot_refs || []),
      heat_zones: rows.flatMap((surface) => surface.heat_zones || []),
      action_count: rows.reduce((sum, surface) => sum + Number(surface.action_count || 0), 0),
      request_count: rows.reduce((sum, surface) => sum + Number(surface.request_count || 0), 0),
    };
  }).sort((left, right) => right.action_count - left.action_count || left.surface_id.localeCompare(right.surface_id));
}

function mergeHeatZones(zones: HeatZone[]): HeatZone[] {
  const clusters: HeatZone[][] = [];
  for (const zone of zones) {
    const cluster = clusters.find((rows) => {
      const center = mergedZoneCenter(rows);
      return rows.some((row) => row.page_id === zone.page_id && row.region === zone.region) &&
        Math.abs(center.x_pct - zone.center.x_pct) <= 6 &&
        Math.abs(center.y_pct - zone.center.y_pct) <= 6;
    });
    if (cluster) cluster.push(zone);
    else clusters.push([zone]);
  }
  return clusters.map((rows, index) => {
    const first = rows[0];
    const center = mergedZoneCenter(rows);
    const count = rows.reduce((sum, row) => sum + row.event_count, 0);
    return {
      ...first,
      zone_id: normalizeIdentifier(`zone_${first.page_id}_${first.region}_${String(index + 1).padStart(3, "0")}`),
      center,
      event_count: count,
      action_types: uniqueSorted(rows.flatMap((row) => row.action_types)),
      top_labels: topValues(rows.flatMap((row) => row.top_labels), 5),
      element_ids: uniqueSorted(rows.flatMap((row) => row.element_ids)),
      request_signatures: uniqueSorted(rows.flatMap((row) => row.request_signatures)),
      evidence_refs: uniqueSorted(rows.flatMap((row) => row.evidence_refs)),
      confidence: Math.min(0.96, rows.reduce((max, row) => Math.max(max, row.confidence), 0.6) + Math.max(0, count - 1) * 0.03),
    };
  }).sort((left, right) => right.event_count - left.event_count);
}

function mergeBusinessModules(modules: BusinessCatalogModule[]): BusinessCatalogModule[] {
  const grouped = new Map<string, BusinessCatalogModule[]>();
  for (const module of modules) {
    const key = module.module_id || normalizeIdentifier(module.title);
    const rows = grouped.get(key) || [];
    rows.push(module);
    grouped.set(key, rows);
  }
  return [...grouped.values()].map((rows) => {
    const first = rows[0];
    const actions = dedupeBy(rows.flatMap((row) => row.actions), (item) => `${item.page_id}:${item.label}:${item.element_id}`);
    return {
      ...first,
      pages: uniqueSorted(rows.flatMap((row) => row.pages)),
      element_ids: uniqueSorted(rows.flatMap((row) => row.element_ids)),
      heat_zone_ids: uniqueSorted(rows.flatMap((row) => row.heat_zone_ids)),
      request_signatures: uniqueSorted(rows.flatMap((row) => row.request_signatures)),
      actions,
      entry_actions: dedupeBy(rows.flatMap((row) => row.entry_actions || []), (item) => item.edge_id),
      exit_actions: dedupeBy(rows.flatMap((row) => row.exit_actions || []), (item) => item.edge_id),
      evidence_refs: uniqueSorted(rows.flatMap((row) => row.evidence_refs)),
      confidence: Math.min(0.97, rows.reduce((max, row) => Math.max(max, row.confidence), 0.65) + Math.max(0, actions.length - 1) * 0.03),
    };
  }).sort((left, right) => right.actions.length - left.actions.length || left.title.localeCompare(right.title));
}

async function synthesizeCapabilities(
  systemKey: string,
  businessCatalog: { modules: BusinessCatalogModule[] },
  actionRulesCatalog: { rules: ActionRule[] },
  pageMap: { pages: PageMapPage[] },
  runIds: string[],
  llmConfig?: LLMConfig,
): Promise<OperationManual> {
  const pageTypeMap = new Map<string, string>();
  for (const page of pageMap.pages) {
    pageTypeMap.set(page.page_id, page.page_type || "other");
  }

  const capabilities: SystemCapability[] = [];
  for (const module of businessCatalog.modules) {
    if (module.confidence < 0.65) continue;

    const steps: SystemCapabilityStep[] = [];
    const sortedActions = [...module.actions].sort((a, b) => {
      const aIdx = a.evidence_refs.length > 0 ? Number(a.evidence_refs[0].split(":").pop()) || 0 : 0;
      const bIdx = b.evidence_refs.length > 0 ? Number(b.evidence_refs[0].split(":").pop()) || 0 : 0;
      return aIdx - bIdx;
    });

    for (let i = 0; i < sortedActions.length; i++) {
      const action = sortedActions[i];
      const actionRule = actionRulesCatalog.rules.find((r) =>
        r.target_element_id === action.element_id && r.entry_page === action.page_id,
      );
      const stepAction = inferStepAction(action.label, actionRule, pageTypeMap.get(action.page_id) || "other");
      steps.push({
        step_number: i + 1,
        action: stepAction,
        description: `${action.label} (${action.page_id})`,
        page_id: action.page_id,
        element_label: action.label,
        element_id: action.element_id || "",
        locator_candidates: [],
      });
    }

    if (module.entry_actions.length > 0 && steps.length > 0) {
      const entry = module.entry_actions[0];
      const existingNavigate = steps.find((s) => s.action === "navigate" && s.page_id === entry.to_page_id);
      if (!existingNavigate) {
        steps.unshift({
          step_number: 0,
          action: "navigate",
          description: `导航到 ${entry.to_page_id}`,
          page_id: entry.to_page_id,
          element_label: entry.label,
          element_id: entry.element_id || "",
          locator_candidates: [],
        });
        for (let i = 0; i < steps.length; i++) steps[i].step_number = i + 1;
      }
    }

    const intentCategory = inferIntentCategory(module, pageTypeMap);
    const pagesInvolved = uniqueSorted([...module.pages, ...steps.map((s) => s.page_id)]);
    const keyElements = uniqueSorted([...module.element_ids, ...steps.map((s) => s.element_id).filter(Boolean)]);
    const sourceRunIds = uniqueSorted(runIds);
    const observationCount = sourceRunIds.length;
    const confidence = Math.min(0.95, module.confidence + 0.03 * Math.max(0, observationCount - 1));

    capabilities.push({
      capability_id: module.module_id || normalizeIdentifier(module.title),
      name: module.title,
      description: "",
      intent_category: intentCategory,
      steps,
      pages_involved: pagesInvolved,
      key_elements: keyElements,
      source_run_ids: sourceRunIds,
      observation_count: observationCount,
      confidence,
    });
  }

  if (llmConfig?.apiKey) {
    for (const cap of capabilities) {
      try {
        const llmResult = await describeCapability(
          llmConfig,
          systemKey,
          cap.name,
          cap.steps.map((s) => s.element_label || s.description),
          cap.pages_involved,
        );
        if (llmResult.description) cap.description = llmResult.description;
        if (llmResult.confidence > 0.5) cap.intent_category = llmResult.intent_category;
      } catch {
        // LLM enhancement is optional; keep heuristic results on failure.
      }
    }
  }

  return {
    generated_at: utcNowIso(),
    schema_version: "v1",
    artifact_type: "operation_manual",
    system_key: systemKey,
    system_name: systemKey,
    capabilities,
    source_run_count: runIds.length,
    source_run_ids: uniqueSorted(runIds),
    confidence: capabilities.length > 0
      ? capabilities.reduce((sum, c) => sum + c.confidence, 0) / capabilities.length
      : 0,
  };
}

function inferStepAction(
  label: string,
  actionRule: ActionRule | undefined,
  pageType: string,
): SystemCapabilityStep["action"] {
  const lower = label.toLowerCase();
  if (/搜索|search|query|查找/.test(lower)) return "fill";
  if (/提交|submit|确认|confirm|保存|save/.test(lower)) return "submit";
  if (/登录|login|sign.?in/.test(lower)) return "submit";
  if (actionRule?.effect && /navigate|跳转|redirect/.test(actionRule.effect)) return "navigate";
  if (pageType === "form" && /输入|填写|input|fill/.test(lower)) return "fill";
  if (pageType === "search" && /搜索|search/.test(lower)) return "fill";
  return "click";
}

function inferIntentCategory(
  module: BusinessCatalogModule,
  pageTypeMap: Map<string, string>,
): SystemCapability["intent_category"] {
  const title = module.title.toLowerCase();
  if (/搜索|search|query|查找/.test(title)) return "search";
  if (/登录|login|sign.?in|认证|auth/.test(title)) return "login";
  if (/设置|setting|配置|config|偏好|preference/.test(title)) return "configure";
  const hasFormPage = module.pages.some((p) => pageTypeMap.get(p) === "form");
  if (hasFormPage && /填写|表单|form|register|注册/.test(title)) return "fill_form";
  if (module.entry_actions.length > 0) return "navigate";
  const pageTypes = module.pages.map((p) => pageTypeMap.get(p));
  if (pageTypes.some((t) => t === "list" || t === "detail" || t === "dashboard")) return "browse";
  return "other";
}

function mergedZoneCenter(zones: HeatZone[]): { x_pct: number; y_pct: number } {
  const total = Math.max(1, zones.reduce((sum, zone) => sum + zone.event_count, 0));
  return {
    x_pct: Math.round((zones.reduce((sum, zone) => sum + zone.center.x_pct * zone.event_count, 0) / total) * 100) / 100,
    y_pct: Math.round((zones.reduce((sum, zone) => sum + zone.center.y_pct * zone.event_count, 0) / total) * 100) / 100,
  };
}

async function shouldMergeRun(store: KnowledgeStore, run: { run_id: string; auth_status?: string }): Promise<boolean> {
  const manifest = await loadRunManifest(store, run.run_id);
  const status = typeof manifest.status === "string" ? manifest.status : "";
  if (SKIPPED_MERGE_MANIFEST_STATUSES.has(status)) return false;
  const auth = manifest.auth && typeof manifest.auth === "object" ? manifest.auth as Record<string, unknown> : {};
  const authStatus = typeof auth.status === "string" && auth.status ? auth.status : run.auth_status || "unknown";
  if (SKIPPED_MERGE_AUTH_STATUSES.has(authStatus)) return false;
  return MERGEABLE_AUTH_STATUSES.has(authStatus);
}

async function loadRunManifest(store: KnowledgeStore, runId: string): Promise<Record<string, unknown>> {
  try {
    const payload = JSON.parse(await readFile(store.runManifestPath(runId), "utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}
