type AutoRecipeApi = {
  open(url: string): Promise<Record<string, unknown>>;
  startCapture(payload: Record<string, string>): Promise<Record<string, unknown>>;
  stopCapture(): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  inspector(): Promise<Record<string, unknown>>;
  listRuns(): Promise<Record<string, unknown>>;
  getLearned(payload?: { runId?: string }): Promise<Record<string, unknown>>;
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
const learnedPanel = document.querySelector<HTMLElement>("#learnedPanel")!;
const openRunDirBtn = document.querySelector<HTMLButtonElement>("#openRunDirBtn")!;
const inspectorOutput = document.querySelector<HTMLElement>("#inspectorOutput")!;
const logOutput = document.querySelector<HTMLElement>("#logOutput")!;

let browserVisible = false;
let refreshInFlight = false;
let selectedRunId = "";
let selectedRunDir = "";

openBtn.addEventListener("click", () => void openTarget());
startBtn.addEventListener("click", () => void startCapture());
stopBtn.addEventListener("click", () => void stopCapture());
toggleBrowserBtn.addEventListener("click", () => void setBrowserVisible(!browserVisible));
openRunDirBtn.addEventListener("click", () => {
  if (selectedRunDir) void window.autorecipe?.openPath(selectedRunDir);
});
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
    const learned = await window.autorecipe?.getLearned({ runId: selectedRunId });
    if (learned) renderLearned(learned);
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
  if (!selectedRunId && runs[0]) selectedRunId = String(runs[0].runId || "");
  if (selectedRunId && !runs.some((run) => String(run.runId || "") === selectedRunId)) {
    selectedRunId = String(runs[0]?.runId || "");
  }
  if (!runs.length) {
    selectedRunId = "";
    selectedRunDir = "";
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
    const runId = String(run.runId || "");
    button.setAttribute("aria-selected", String(runId === selectedRunId));
    button.addEventListener("click", () => {
      selectedRunId = runId;
      selectedRunDir = String(run.runDir || "");
      renderRuns(payload);
      void window.autorecipe?.getLearned({ runId: selectedRunId }).then((learned) => renderLearned(learned));
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

function renderLearned(payload: Record<string, unknown>): void {
  selectedRunId = String(payload.runId || selectedRunId || "");
  selectedRunDir = String(payload.runDir || selectedRunDir || "");
  openRunDirBtn.disabled = !selectedRunDir;
  learnedPanel.textContent = "";
  if (!selectedRunId) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Stop a capture to see learned pages, modules, requests, rules, and recipes.";
    learnedPanel.appendChild(empty);
    return;
  }

  const title = document.createElement("div");
  title.className = "learnedTitle";
  title.textContent = String(payload.title || payload.systemKey || selectedRunId);
  learnedPanel.appendChild(title);

  const counts = toRecord(payload.counts);
  const grid = document.createElement("div");
  grid.className = "learnedGrid";
  [
    ["Pages", counts.pages],
    ["Modules", counts.modules],
    ["Requests", counts.requests],
    ["Rules", counts.rules],
    ["Steps", counts.recipeSteps],
    ["Shots", counts.screenshots],
  ].forEach(([label, value]) => {
    const cell = document.createElement("div");
    cell.className = "learnedCount";
    const strong = document.createElement("strong");
    strong.textContent = String(Number(value || 0));
    const caption = document.createElement("span");
    caption.textContent = String(label);
    cell.append(strong, caption);
    grid.appendChild(cell);
  });
  learnedPanel.appendChild(grid);

  appendLearnedGroup("Pages", listRecords(payload.pages), (page) => ({
    title: String(page.id || page.type || "page"),
    meta: [page.type, page.requests ? `${page.requests} requests` : "", page.heatZones ? `${page.heatZones} zones` : "", page.url].filter(Boolean).join(" · "),
  }));
  appendLearnedGroup("Modules", listRecords(payload.modules), (module) => ({
    title: String(module.title || module.id || "module"),
    meta: [
      module.sourceRegion,
      module.pages ? `${module.pages} pages` : "",
      module.requests ? `${module.requests} requests` : "",
      Array.isArray(module.actions) ? module.actions.join(", ") : "",
    ].filter(Boolean).join(" · "),
  }));
  appendLearnedGroup("Requests", listRecords(payload.requests), (request) => ({
    title: `${String(request.method || "GET")} ${String(request.path || request.signature || "/")}`,
    meta: [request.host, request.category, request.occurrence ? `${request.occurrence}x` : "", request.status ? `HTTP ${request.status}` : ""].filter(Boolean).join(" · "),
  }));
  appendLearnedGroup("Rules", listRecords(payload.rules), (rule) => ({
    title: String(rule.action || rule.id || "rule"),
    meta: [rule.page, rule.effect, rule.risk ? `risk:${rule.risk}` : ""].filter(Boolean).join(" · "),
  }));

  const recipe = toRecord(payload.recipe);
  appendLearnedGroup("Recipe", listRecords(recipe.steps), (step) => ({
    title: `${String(step.action || "step")} ${String(step.text || "").trim()}`.trim(),
    meta: [step.page, step.region].filter(Boolean).join(" · "),
  }));
}

function appendLearnedGroup(
  title: string,
  rows: Array<Record<string, unknown>>,
  render: (row: Record<string, unknown>) => { title: string; meta: string },
): void {
  const group = document.createElement("div");
  group.className = "learnedGroup";
  const heading = document.createElement("div");
  heading.className = "learnedGroupTitle";
  heading.textContent = title;
  group.appendChild(heading);
  const list = document.createElement("div");
  list.className = "learnedList";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `No ${title.toLowerCase()} learned yet.`;
    list.appendChild(empty);
  } else {
    for (const row of rows.slice(0, 6)) {
      const item = document.createElement("div");
      item.className = "learnedItem";
      const rendered = render(row);
      const itemTitle = document.createElement("div");
      itemTitle.className = "learnedItemTitle";
      itemTitle.textContent = rendered.title || title;
      const meta = document.createElement("div");
      meta.className = "learnedItemMeta";
      meta.textContent = rendered.meta || "-";
      item.append(itemTitle, meta);
      list.appendChild(item);
    }
  }
  group.appendChild(list);
  learnedPanel.appendChild(group);
}

function setCaptureState(value: string): void {
  captureState.textContent = value;
  captureState.dataset.kind = value;
  stopBtn.disabled = value !== "recording";
  startBtn.disabled = value === "recording" || value === "stopping";
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function listRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
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
