import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from "electron";
import { DesktopBrowserRuntime } from "@autorecipe/browser-runtime";
import { buildMiningInspector } from "./autorecipeInspector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cdpPort = Number(process.env.AUTORECIPE_CDP_PORT || 17375);

app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

const singleInstanceLock = app.requestSingleInstanceLock();

let runtime: DesktopBrowserRuntime | undefined;
let themeChoice: "system" | "light" | "dark" = "system";

async function bootstrap(): Promise<void> {
  const workspaceRoot = path.resolve(
    process.env.AUTORECIPE_WORKSPACE_ROOT
      || path.join(app.getPath("userData"), "workspaces", "default"),
  );
  runtime = new DesktopBrowserRuntime({
    knowledgeRoot: workspaceRoot,
    appPreloadPath: path.join(__dirname, "appPreload.js"),
    capturePreloadPath: path.join(__dirname, "capturePreload.js"),
    cdpPort,
    browserPartition: "persist:autorecipe-default",
    llmConfig: miningLlmConfig(),
  });

  const win = await runtime.createWindow();
  installAppIpc();
  await win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.send("autorecipe:set-theme", resolvedTheme());
  runtime.attachBusinessView();
  runtime.setExplorationVisible(false);
}

function installAppIpc(): void {
  ipcMain.handle("autorecipe:inspector", async () => runtimeInspector());
  ipcMain.handle("autorecipe:runs:list", async () => listRuns());
  ipcMain.handle("autorecipe:learned:get", async (_event, payload: { runId?: string } = {}) => getLearnedArtifacts(payload?.runId));
  ipcMain.handle("autorecipe:open-path", async (_event, filePath: string) => openPath(filePath));
  ipcMain.handle("ui:set-exploration-visible", async (_event, visible: boolean) => {
    runtime?.setExplorationVisible(Boolean(visible));
    return { success: true, visible: Boolean(visible) };
  });
  ipcMain.handle("ui:set-workspace-expanded", async (_event, expanded: boolean) => {
    runtime?.setWorkspaceExpanded(Boolean(expanded));
    return { success: true, expanded: Boolean(expanded) };
  });
  ipcMain.handle("ui:theme:get", async () => ({
    success: true,
    choice: themeChoice,
    theme: resolvedTheme(),
  }));
  ipcMain.handle("ui:theme:set", async (_event, choice: string) => {
    themeChoice = normalizeThemeChoice(choice);
    nativeTheme.themeSource = themeChoice;
    broadcastTheme();
    return { success: true, choice: themeChoice, theme: resolvedTheme() };
  });
}

function installApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    } satisfies MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { role: isMac ? "close" : "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function miningLlmConfig(): { apiKey: string; baseUrl?: string; model?: string } | undefined {
  const apiKey = String(process.env.AUTORECIPE_LLM_API_KEY || "").trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: String(process.env.AUTORECIPE_LLM_BASE_URL || "").trim() || undefined,
    model: String(process.env.AUTORECIPE_LLM_MODEL || "").trim() || undefined,
  };
}

async function runtimeInspector(): Promise<Record<string, unknown>> {
  if (!runtime) return buildMiningInspector({ active: false, events: [] });
  const active = runtime.capture.active()[0];
  const runs = await runtime.store.listRuns();
  const latestRunId = runs.at(-1)?.run_id || "";
  const runId = active?.runId || latestRunId;
  const events = runId ? await runtime.store.loadEvents(runId).catch(() => []) : [];
  return buildMiningInspector({
    active: Boolean(active),
    runId,
    events: events as Array<{ event_type?: string; url?: string; ts?: string; payload?: Record<string, unknown> }>,
  });
}

async function listRuns(): Promise<Record<string, unknown>> {
  if (!runtime) return { success: false, runs: [] };
  const runs = await runtime.store.listRuns();
  return {
    success: true,
    workspaceRoot: runtime.store.root,
    miningRoot: runtime.store.miningRoot(),
    runs: [...runs].reverse().map((run) => ({
      runId: run.run_id,
      systemKey: run.system_key,
      targetUrl: run.entry_url || run.url,
      currentUrl: run.current_url || run.url,
      authStatus: run.auth_status,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      runDir: runtime?.store.runDir(run.run_id),
      artifacts: {
        manifest: runtime?.store.runManifestPath(run.run_id),
        pageMap: runtime?.store.artifactPath(run.run_id, "page_map"),
        businessCatalog: runtime?.store.artifactPath(run.run_id, "business_catalog"),
        requestCatalog: runtime?.store.artifactPath(run.run_id, "request_catalog"),
        actionRules: runtime?.store.artifactPath(run.run_id, "action_rules"),
        recipePack: runtime?.store.artifactPath(run.run_id, "recipe_pack"),
        summary: runtime?.store.artifactPath(run.run_id, "summary"),
      },
    })),
  };
}

async function getLearnedArtifacts(inputRunId?: string): Promise<Record<string, unknown>> {
  if (!runtime) return { success: false, error: "runtime is not ready" };
  const active = runtime.capture.active()[0];
  const runs = await runtime.store.listRuns();
  const selected = String(inputRunId || "").trim();
  const run = selected
    ? runs.find((item) => item.run_id === selected)
    : active
      ? runs.find((item) => item.run_id === active.runId) || runs.at(-1)
      : runs.at(-1);
  if (!run) {
    return {
      success: true,
      runId: "",
      title: "No learned artifacts yet",
      counts: { pages: 0, modules: 0, requests: 0, rules: 0, recipeSteps: 0 },
      pages: [],
      modules: [],
      requests: [],
      rules: [],
      recipe: null,
    };
  }

  const [pageMap, businessCatalog, requestCatalog, actionRules, recipePack, summary] = await Promise.all([
    loadArtifact(run.run_id, "page_map"),
    loadArtifact(run.run_id, "business_catalog"),
    loadArtifact(run.run_id, "request_catalog"),
    loadArtifact(run.run_id, "action_rules"),
    loadArtifact(run.run_id, "recipe_pack"),
    loadArtifact(run.run_id, "summary"),
  ]);
  const pages = records(pageMap.pages).map((page) => ({
    id: text(page.page_id),
    url: text(page.page_url),
    type: text(page.page_type || "page"),
    description: text(page.page_description),
    regions: stringList(page.regions).slice(0, 6),
    heatZones: records(page.heat_zones).length,
    requests: numberValue(page.request_count),
    screenshotPath: latestScreenshotPath(page),
  }));
  const modules = records(businessCatalog.modules).map((module) => ({
    id: text(module.module_id),
    title: text(module.title || module.module_id),
    sourceRegion: text(module.source_region),
    pages: stringList(module.pages).length,
    actions: records(module.actions).map((action) => text(action.label)).filter(Boolean).slice(0, 6),
    requests: stringList(module.request_signatures).length,
  }));
  const requests = records(requestCatalog.requests).map((request) => ({
    signature: text(request.signature),
    method: text(request.method).toUpperCase(),
    host: text(request.host),
    path: text(request.path_template || request.path),
    category: text(request.request_category || "business"),
    occurrence: numberValue(request.occurrence),
    status: numberValue(request.status_code),
  }));
  const rules = records(actionRules.rules).map((rule) => ({
    id: text(rule.rule_id),
    action: text(rule.canonical_action),
    page: text(rule.current_page || rule.entry_page),
    effect: text(rule.effect),
    risk: text(rule.risk_level || "low"),
    success: stringList(rule.success_criteria).slice(0, 4),
  }));
  const recipeSteps = records(recipePack.steps);

  return {
    success: true,
    runId: run.run_id,
    systemKey: run.system_key,
    targetUrl: run.entry_url || run.url,
    currentUrl: run.current_url || run.url,
    updatedAt: run.updated_at,
    runDir: runtime.store.runDir(run.run_id),
    title: text(recipePack.title || run.system_key),
    preview: await learnedPreview(run.run_id, pageMap),
    counts: {
      pages: pages.length,
      modules: modules.length,
      requests: requests.length,
      rules: rules.length,
      recipeSteps: recipeSteps.length,
      screenshots: numberValue(record(summary.counts).screenshots),
      actions: numberValue(record(summary.counts).actions || recipeSteps.length),
    },
    pages: pages.slice(0, 12),
    modules: modules.slice(0, 12),
    requests: requests.slice(0, 16),
    rules: rules.slice(0, 16),
    recipe: {
      id: text(recipePack.recipe_id),
      title: text(recipePack.title),
      description: text(recipePack.description),
      steps: recipeSteps.map((step) => ({
        action: text(step.action),
        page: text(step.page),
        text: text(step.text || step.semantic_action || step.element_id),
        region: text(step.region),
      })).slice(0, 12),
    },
  };
}

async function learnedPreview(runId: string, pageMap: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pages = records(pageMap.pages);
  const pageWithShot = pages.find((page) => latestScreenshotPath(page))
    || pages.find((page) => records(page.heat_zones).length)
    || pages[0];
  if (pageWithShot) {
    const screenshotPath = latestScreenshotPath(pageWithShot);
    return {
      mode: "artifact",
      pageId: text(pageWithShot.page_id),
      pageUrl: text(pageWithShot.page_url),
      screenshotPath,
      screenshotUrl: fileUrl(screenshotPath),
      heatZones: records(pageWithShot.heat_zones).map((zone) => ({
        label: stringList(zone.top_labels)[0] || text(zone.region) || "action",
        region: text(zone.region),
        count: numberValue(zone.event_count),
        bbox: record(zone.bbox_pct),
      })).slice(0, 16),
      regions: records(pageWithShot.region_partitions).map((region) => ({
        label: text(region.region),
        bbox: {
          x: numberValue(region.x_pct),
          y: numberValue(region.y_pct),
          width: numberValue(region.width_pct),
          height: numberValue(region.height_pct),
        },
      })).slice(0, 10),
    };
  }

  const events = await runtime?.store.loadEvents(runId).catch(() => []) || [];
  const parsed = events.map((item) => record(item));
  const latestShot = [...parsed].reverse().find((event) => text(record(event.payload).storage_ref));
  const screenshotPath = text(record(latestShot?.payload).storage_ref);
  const actions = parsed
    .filter((event) => /^ui_/.test(text(event.event_type)))
    .map((event) => {
      const payload = record(event.payload);
      const xPct = numberValue(payload.x_pct);
      const yPct = numberValue(payload.y_pct);
      if (!xPct && !yPct) return undefined;
      return {
        label: text(payload.label || payload.text || event.event_type) || "action",
        region: text(payload.region || "main_content"),
        count: 1,
        bbox: {
          x: Math.max(0, xPct - 3),
          y: Math.max(0, yPct - 3),
          width: 6,
          height: 6,
        },
      };
    })
    .filter(Boolean)
    .slice(-16);
  return {
    mode: "live",
    pageUrl: text(record(latestShot?.payload).page_url || latestShot?.url),
    screenshotPath,
    screenshotUrl: fileUrl(screenshotPath),
    heatZones: actions,
    regions: [],
  };
}

async function openPath(filePath: string): Promise<Record<string, unknown>> {
  const target = String(filePath || "").trim();
  if (!target) return { success: false, error: "path is empty" };
  const error = await shell.openPath(target);
  return error ? { success: false, error } : { success: true, path: target };
}

async function loadArtifact(runId: string, artifactType: string): Promise<Record<string, unknown>> {
  if (!runtime) return {};
  try {
    return JSON.parse(await readFile(runtime.store.artifactPath(runId, artifactType), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function latestScreenshotPath(page: Record<string, unknown>): string {
  const screenshots = records(page.screenshot_refs);
  return text(screenshots.at(-1)?.path || screenshots.at(-1)?.ref);
}

function fileUrl(filePath: string): string {
  return filePath ? pathToFileURL(filePath).toString() : "";
}

function normalizeThemeChoice(value: string): "system" | "light" | "dark" {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function resolvedTheme(): "light" | "dark" {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function broadcastTheme(): void {
  const theme = resolvedTheme();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("autorecipe:set-theme", theme);
  }
}

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    installApplicationMenu();
    nativeTheme.on("updated", () => {
      if (themeChoice === "system") broadcastTheme();
    });
    void bootstrap().catch((error) => {
      console.error("[autorecipe] bootstrap failed", error);
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
