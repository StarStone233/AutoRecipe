export type MiningInspectorEvent = {
  event_type?: string;
  url?: string;
  ts?: string;
  payload?: Record<string, unknown>;
};

export type MiningInspectorAction = {
  ts: string;
  label: string;
  region: string;
  kind: "navigation" | "input" | "action";
  page_id: string;
  request_count: number;
};

export type MiningInspectorNavigationEdge = {
  direction: "enter" | "exit" | "move";
  label: string;
  from_page_id: string;
  to_page_id: string;
  source_region: string;
};

export type MiningInspectorModule = {
  title: string;
  entry_count: number;
  exit_count: number;
};

export type MiningInspectorHeatZone = {
  region: string;
  label: string;
  event_count: number;
  page_id: string;
};

export type MiningInspectorEntryPoint = {
  text: string;
  href: string;
  region: string;
  x_pct: number;
  y_pct: number;
  tag: string;
};

export type MiningInspectorSummary = {
  active: boolean;
  runId: string;
  page_id: string;
  page_url: string;
  counts: {
    actions: number;
    navigation_edges: number;
    modules: number;
    heat_zones: number;
    requests: number;
  };
  navigation_edges: MiningInspectorNavigationEdge[];
  modules: MiningInspectorModule[];
  heat_zones: MiningInspectorHeatZone[];
  recent_actions: MiningInspectorAction[];
  entry_points: MiningInspectorEntryPoint[];
};

type ActionDraft = {
  ts: string;
  label: string;
  region: string;
  pageId: string;
  pageUrl: string;
  kind: "navigation" | "input" | "action";
  requestCount: number;
};

export function buildMiningInspector(input: {
  active?: boolean;
  runId?: string;
  events?: MiningInspectorEvent[];
}): MiningInspectorSummary {
  const events = input.events || [];
  const entryPageUrl = firstPageUrl(events);
  const entryPageId = pageIdFromUrl(entryPageUrl);
  let currentPageUrl = entryPageUrl;
  let currentPageId = entryPageId;
  let lastAction: ActionDraft | undefined;
  const actions: ActionDraft[] = [];
  const navigationEdges: MiningInspectorNavigationEdge[] = [];
  let requestCount = 0;

  for (const event of events) {
    const type = String(event.event_type || "").toLowerCase();
    const payload = event.payload || {};
    const eventPageUrl = eventUrl(event) || currentPageUrl;
    const eventPageId = pageIdFromUrl(eventPageUrl);
    if (eventPageUrl) {
      currentPageUrl = eventPageUrl;
      currentPageId = eventPageId;
    }

    if (isActionEvent(type)) {
      const label = compact(String(payload.label || payload.text || payload.aria_label || "unknown"));
      const region = compact(String(payload.region || inferRegion(payload)));
      lastAction = {
        ts: String(event.ts || ""),
        label,
        region,
        pageId: eventPageId,
        pageUrl: eventPageUrl,
        kind: isNavigationRegion(region) ? "navigation" : type === "ui_input" || type === "ui_change" ? "input" : "action",
        requestCount: 0,
      };
      actions.push(lastAction);
      continue;
    }

    if (type.startsWith("network_")) {
      requestCount += 1;
      if (lastAction) lastAction.requestCount += 1;
      continue;
    }

    if ((type === "url_change" || type === "page_loaded") && lastAction && eventPageId !== lastAction.pageId) {
      navigationEdges.push({
        direction: navigationDirection(lastAction, entryPageId, eventPageId),
        label: lastAction.label,
        from_page_id: lastAction.pageId,
        to_page_id: eventPageId,
        source_region: lastAction.region,
      });
    }
  }

  const entryPoints: MiningInspectorEntryPoint[] = [];
  for (const event of events) {
    if (String(event.event_type || "").toLowerCase() !== "entry_points_scan") continue;
    const entries = Array.isArray(event.payload?.entries) ? event.payload.entries as Record<string, unknown>[] : [];
    for (const entry of entries) {
      entryPoints.push({
        text: String(entry.text || "").slice(0, 60),
        href: String(entry.href || "").slice(0, 120),
        region: String(entry.region || "main_content"),
        x_pct: Number(entry.x_pct || 0),
        y_pct: Number(entry.y_pct || 0),
        tag: String(entry.tag || "a"),
      });
    }
    break; // only take the latest scan
  }

  const modules = buildModules(actions, navigationEdges);
  const heatZones = buildHeatZones(actions);
  return {
    active: Boolean(input.active),
    runId: String(input.runId || ""),
    page_id: currentPageId,
    page_url: currentPageUrl,
    counts: {
      actions: actions.length,
      navigation_edges: navigationEdges.length,
      modules: modules.length,
      heat_zones: heatZones.length,
      requests: requestCount,
    },
    navigation_edges: navigationEdges.slice(-6),
    modules,
    heat_zones: heatZones.slice(0, 8),
    recent_actions: actions.slice(-10).reverse().map((action) => ({
      ts: action.ts,
      label: action.label,
      region: action.region,
      kind: action.kind,
      page_id: action.pageId,
      request_count: action.requestCount,
    })),
    entry_points: entryPoints,
  };
}

function firstPageUrl(events: MiningInspectorEvent[]): string {
  for (const event of events) {
    const url = eventUrl(event);
    if (url) return url;
  }
  return "";
}

function eventUrl(event: MiningInspectorEvent): string {
  return String(event.payload?.page_url || event.url || event.payload?.document_url || "").trim();
}

function isActionEvent(type: string): boolean {
  return ["ui_click", "ui_input", "ui_change", "ui_submit", "ui_state_change"].includes(type);
}

function isNavigationRegion(region: string): boolean {
  return ["left_nav", "top_nav", "top_bar", "navigation", "menu"].includes(region);
}

function isExitLabel(label: string): boolean {
  return /返回|退出|关闭|取消|首页|back|home|close|exit/i.test(label);
}

function navigationDirection(action: ActionDraft, entryPageId: string, nextPageId: string): "enter" | "exit" | "move" {
  if (isExitLabel(action.label) || nextPageId === entryPageId && action.pageId !== entryPageId) return "exit";
  if (isNavigationRegion(action.region)) return "enter";
  return "move";
}

function buildModules(actions: ActionDraft[], edges: MiningInspectorNavigationEdge[]): MiningInspectorModule[] {
  const titles = new Map<string, MiningInspectorModule>();
  for (const action of actions) {
    if (!isNavigationRegion(action.region) || isExitLabel(action.label) || action.label === "unknown") continue;
    const current = titles.get(action.label) || { title: action.label, entry_count: 0, exit_count: 0 };
    current.entry_count += edges.filter((edge) => edge.label === action.label && edge.direction === "enter").length || 1;
    current.exit_count = edges.filter((edge) => edge.direction === "exit").length;
    titles.set(action.label, current);
  }
  return [...titles.values()].sort((left, right) => right.entry_count - left.entry_count || left.title.localeCompare(right.title)).slice(0, 8);
}

function buildHeatZones(actions: ActionDraft[]): MiningInspectorHeatZone[] {
  const zones = new Map<string, MiningInspectorHeatZone>();
  for (const action of actions) {
    const key = `${action.pageId}:${action.region}:${action.label}`;
    const zone = zones.get(key) || { page_id: action.pageId, region: action.region, label: action.label, event_count: 0 };
    zone.event_count += 1;
    zones.set(key, zone);
  }
  return [...zones.values()].sort((left, right) => right.event_count - left.event_count || left.label.localeCompare(right.label));
}

function inferRegion(payload: Record<string, unknown>): string {
  const text = [payload.label, payload.text, payload.class_name, payload.role].map((item) => String(item || "").toLowerCase()).join(" ");
  if (/sidebar|sider|menu|navigation|tree|left/.test(text)) return "left_nav";
  if (/header|navbar|breadcrumb|top|toolbar/.test(text)) return "top_bar";
  if (/filter|search|query|condition|form/.test(text)) return "filter_panel";
  return "main_content";
}

function pageIdFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return normalizeIdentifier(`${url.hostname}${url.pathname || "/"}`);
  } catch {
    return normalizeIdentifier(rawUrl || "page");
  }
}

function normalizeIdentifier(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "page";
}

function compact(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim() || "unknown";
}
