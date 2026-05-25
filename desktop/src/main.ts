import path from "node:path";
import { fileURLToPath } from "node:url";
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

async function openPath(filePath: string): Promise<Record<string, unknown>> {
  const target = String(filePath || "").trim();
  if (!target) return { success: false, error: "path is empty" };
  const error = await shell.openPath(target);
  return error ? { success: false, error } : { success: true, path: target };
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
