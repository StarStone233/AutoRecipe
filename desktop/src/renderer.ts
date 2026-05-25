type AutoRecipeApi = {
  open(url: string): Promise<Record<string, unknown>>;
  startCapture(payload: Record<string, string>): Promise<Record<string, unknown>>;
  stopCapture(): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  inspector(): Promise<Record<string, unknown>>;
  listRuns(): Promise<Record<string, unknown>>;
  openPath(path: string): Promise<Record<string, unknown>>;
  setExplorationVisible(visible: boolean): Promise<Record<string, unknown>>;
  setWorkspaceExpanded(expanded: boolean): Promise<Record<string, unknown>>;
  getTheme(): Promise<{ theme?: "light" | "dark"; choice?: "system" | "light" | "dark" }>;
  setTheme(choice: "system" | "light" | "dark"): Promise<{ theme?: "light" | "dark"; choice?: "system" | "light" | "dark" }>;
  onThemeChange(callback: (theme: "light" | "dark") => void): () => void;
};

declare global {
  interface Window {
    autorecipe?: AutoRecipeApi;
  }
}

const targetUrl = document.querySelector<HTMLInputElement>("#targetUrl")!;
const openBtn = document.querySelector<HTMLButtonElement>("#openBtn")!;
const startBtn = document.querySelector<HTMLButtonElement>("#startBtn")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stopBtn")!;
const toggleBrowserBtn = document.querySelector<HTMLButtonElement>("#toggleBrowserBtn")!;
const themeSelect = document.querySelector<HTMLSelectElement>("#themeSelect")!;
const captureState = document.querySelector<HTMLElement>("#captureState")!;
const cdpEndpoint = document.querySelector<HTMLElement>("#cdpEndpoint")!;
const currentUrl = document.querySelector<HTMLElement>("#currentUrl")!;
const workspaceRoot = document.querySelector<HTMLElement>("#workspaceRoot")!;
const runList = document.querySelector<HTMLElement>("#runList")!;
const inspectorOutput = document.querySelector<HTMLElement>("#inspectorOutput")!;
const logOutput = document.querySelector<HTMLElement>("#logOutput")!;

let browserVisible = false;
let refreshInFlight = false;

openBtn.addEventListener("click", () => void openTarget());
startBtn.addEventListener("click", () => void startCapture());
stopBtn.addEventListener("click", () => void stopCapture());
toggleBrowserBtn.addEventListener("click", () => void setBrowserVisible(!browserVisible));
themeSelect.addEventListener("change", () => {
  void window.autorecipe?.setTheme(themeSelect.value as "system" | "light" | "dark").then((result) => {
    if (result.theme) applyTheme(result.theme);
  });
});

targetUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void openTarget();
});

void window.autorecipe?.getTheme().then((result) => {
  if (result.choice) themeSelect.value = result.choice;
  if (result.theme) applyTheme(result.theme);
}).catch(() => undefined);
window.autorecipe?.onThemeChange((theme) => applyTheme(theme));

void refreshAll();
setInterval(() => void refreshAll(), 2500);

async function openTarget(): Promise<void> {
  const url = targetUrl.value.trim();
  if (!url) return;
  await setBrowserVisible(true);
  log(`opening ${url}`);
  try {
    const result = await window.autorecipe?.open(url);
    log(JSON.stringify(result, null, 2));
    await refreshAll();
  } catch (error) {
    logError(error);
  }
}

async function startCapture(): Promise<void> {
  const url = targetUrl.value.trim();
  await setBrowserVisible(true);
  setCaptureState("recording");
  log("starting capture");
  try {
    const result = await window.autorecipe?.startCapture({ targetUrl: url });
    log(JSON.stringify(result, null, 2));
    await refreshAll();
  } catch (error) {
    setCaptureState("error");
    logError(error);
  }
}

async function stopCapture(): Promise<void> {
  setCaptureState("stopping");
  log("stopping capture");
  try {
    const result = await window.autorecipe?.stopCapture();
    log(JSON.stringify(result, null, 2));
    await refreshAll();
  } catch (error) {
    setCaptureState("error");
    logError(error);
  }
}

async function setBrowserVisible(visible: boolean): Promise<void> {
  browserVisible = visible;
  document.body.dataset.browserVisible = String(visible);
  toggleBrowserBtn.textContent = visible ? "Hide" : "Browser";
  await window.autorecipe?.setExplorationVisible(visible).catch(() => undefined);
  await window.autorecipe?.setWorkspaceExpanded(visible).catch(() => undefined);
}

async function refreshAll(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const [status, inspector, runs] = await Promise.all([
      window.autorecipe?.status(),
      window.autorecipe?.inspector(),
      window.autorecipe?.listRuns(),
    ]);
    if (status) renderStatus(status);
    if (inspector) inspectorOutput.textContent = JSON.stringify(inspector, null, 2);
    if (runs) renderRuns(runs);
  } catch (error) {
    logError(error);
  } finally {
    refreshInFlight = false;
  }
}

function renderStatus(status: Record<string, unknown>): void {
  const active = Array.isArray(status.active) && status.active.length > 0;
  setCaptureState(active ? "recording" : "standby");
  const current = String(status.currentUrl || "");
  currentUrl.textContent = current || "-";
  if (current && !targetUrl.value) targetUrl.value = current;
  cdpEndpoint.textContent = String(status.cdpEndpoint || "-");
  workspaceRoot.textContent = String(status.workspaceRoot || status.knowledgeRoot || "-");
}

function renderRuns(payload: Record<string, unknown>): void {
  const runs = Array.isArray(payload.runs) ? payload.runs as Array<Record<string, unknown>> : [];
  runList.textContent = "";
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No mining runs yet.";
    runList.appendChild(empty);
    return;
  }
  for (const run of runs.slice(0, 8)) {
    const button = document.createElement("button");
    button.className = "runCard";
    button.type = "button";
    button.addEventListener("click", () => {
      const runDir = String(run.runDir || "");
      if (runDir) void window.autorecipe?.openPath(runDir);
    });
    const title = document.createElement("div");
    title.className = "runTitle";
    title.textContent = String(run.systemKey || run.runId || "run");
    const meta = document.createElement("div");
    meta.className = "runMeta";
    meta.textContent = `${String(run.authStatus || "unknown")} · ${formatTime(String(run.updatedAt || run.createdAt || ""))}`;
    const url = document.createElement("div");
    url.className = "runMeta";
    url.textContent = String(run.currentUrl || run.targetUrl || "");
    button.append(title, meta, url);
    runList.appendChild(button);
  }
}

function setCaptureState(value: string): void {
  captureState.textContent = value;
  captureState.dataset.kind = value;
  stopBtn.disabled = value !== "recording";
  startBtn.disabled = value === "recording" || value === "stopping";
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
}

function log(message: string): void {
  const previous = logOutput.textContent || "";
  logOutput.textContent = `${new Date().toLocaleTimeString()} ${message}\n${previous}`.slice(0, 12000);
}

function logError(error: unknown): void {
  log(error instanceof Error ? error.message : String(error));
}

function formatTime(value: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
