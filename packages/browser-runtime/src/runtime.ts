import path from "node:path";
import {
  BrowserView,
  BrowserWindow,
  ipcMain,
  session as electronSession,
  WebContents,
} from "electron";
import {
  CaptureSession,
  CaptureSessionManager,
  toNetworkCompletedEvent,
} from "@autorecipe/capture-core";
import {
  AuthVerification,
  hostFromUrl,
  KnowledgeStore,
  systemKeyFromUrl,
  type LLMConfig,
} from "@autorecipe/knowledge-core";
import { analyzeAuthSnapshot, shouldNavigateForAuthTarget } from "./authState.js";
import {
  businessViewBounds as resolveBusinessViewBounds,
  businessViewZoom,
  HORIZONTAL_FIT_SCROLL_CSS,
  PERFORMANCE_CAPTURE_POLICY,
  PERSONAL_COLLAPSED_WINDOW_WIDTH,
  PERSONAL_SIDEBAR_WIDTH,
  windowResizeIntentForBusinessView,
  windowResizeIntentForWorkspaceExpansion,
  type BusinessViewBounds,
} from "./viewPolicy.js";

type PendingRequest = {
  startedAtMs: number;
  pageUrl: string;
  tabId: number;
};

type AuthStateInput = {
  targetUrl?: string;
  authProfile?: string;
};

type PageAuthSnapshot = {
  url: string;
  title: string;
  text: string;
  selectors: string[];
  storageKeys: string[];
};

const AUTH_INTERRUPT_STATUSES = new Set<AuthVerification["status"]>(["required", "expired", "blocked"]);
export type DesktopRuntimeOptions = {
  knowledgeRoot: string;
  appPreloadPath: string;
  capturePreloadPath: string;
  cdpPort: number;
  browserPartition: string;
  llmConfig?: LLMConfig;
};

export class DesktopBrowserRuntime {
  readonly store: KnowledgeStore;
  readonly capture: CaptureSessionManager;
  private window?: BrowserWindow;
  private view?: BrowserView;
  private activeSession?: CaptureSession;
  private snapshotTimer?: NodeJS.Timeout;
  private explorationVisible = false;
  private workspaceExpanded = false;
  private scrollbarCssKey?: string;
  private lastAuthInterruptEventKey?: string;
  private lastBusinessViewBounds?: BusinessViewBounds;
  private lastBusinessViewZoom?: number;
  private snapshotInFlight = false;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingInteractionContexts = new Map<string, { url: string; interaction_ref: Record<string, unknown>; receivedAtMs: number }>();

  constructor(private readonly options: DesktopRuntimeOptions) {
    this.store = new KnowledgeStore(options.knowledgeRoot);
    this.capture = new CaptureSessionManager(this.store, options.llmConfig);
  }

  cdpEndpoint(): string {
    return `http://127.0.0.1:${this.options.cdpPort}`;
  }

  async createWindow(): Promise<BrowserWindow> {
    await this.store.ensureRoot();
    const win = new BrowserWindow({
      width: PERSONAL_COLLAPSED_WINDOW_WIDTH,
      height: 780,
      minWidth: PERSONAL_SIDEBAR_WIDTH,
      minHeight: 680,
      webPreferences: {
        preload: this.options.appPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window = win;
    this.installIpc();
    this.installNetworkCapture();
    return win;
  }

  attachBusinessView(initialUrl = "about:blank"): BrowserView {
    if (!this.window) throw new Error("window not created");
    const view = new BrowserView({
      webPreferences: {
        preload: this.options.capturePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.options.browserPartition,
      },
    });
    this.view = view;
    this.window.setBrowserView(view);
    this.layoutBusinessView();
    this.window.on("resize", () => this.layoutBusinessView());
    view.webContents.on("did-finish-load", () => {
      void this.installBusinessPageChrome();
    });
    void view.webContents.loadURL(initialUrl);
    return view;
  }

  setExplorationVisible(visible: boolean): void {
    if (this.window) {
      const bounds = this.window.getBounds();
      const resize = windowResizeIntentForBusinessView({
        visible,
        windowWidth: bounds.width,
        windowHeight: bounds.height,
      });
      if (resize) this.window.setSize(resize.width, resize.height, resize.animate);
    }
    this.explorationVisible = visible;
    this.layoutBusinessView();
  }

  setWorkspaceExpanded(expanded: boolean): void {
    if (!this.window) return;
    const bounds = this.window.getBounds();
    const resize = windowResizeIntentForWorkspaceExpansion({
      expanded,
      businessVisible: this.explorationVisible,
      windowWidth: bounds.width,
      windowHeight: bounds.height,
    });
    if (resize) this.window.setSize(resize.width, resize.height, resize.animate);
    this.workspaceExpanded = expanded;
    this.layoutBusinessView();
  }

  businessWebContents(): WebContents {
    if (!this.view) throw new Error("business view not created");
    return this.view.webContents;
  }

  businessViewState(): Record<string, unknown> {
    return {
      visible: this.explorationVisible,
      bounds: this.view?.getBounds() || null,
      windowBounds: this.window?.getBounds() || null,
      zoomFactor: this.view?.webContents.getZoomFactor() || 1,
      workspaceExpanded: this.workspaceExpanded,
      currentUrl: this.view?.webContents.getURL() || "",
      title: this.view?.webContents.getTitle() || "",
    };
  }

  ensureBusinessViewVisible(): void {
    this.setExplorationVisible(true);
    this.layoutBusinessView();
  }

  async open(url: string): Promise<Record<string, unknown>> {
    const wc = this.businessWebContents();
    const requestedUrl = normalizeBrowserUrl(url);
    if (requestedUrl === "about:blank") {
      return {
        success: false,
        error: "URL is empty. Enter a URL like https://example.com, example.com, or localhost:3000.",
        requestedUrl,
        currentUrl: wc.getURL(),
      };
    }

    const result = await waitForNavigation(wc, async () => {
      await wc.loadURL(requestedUrl);
    });
    return {
      success: result.success,
      requestedUrl,
      currentUrl: wc.getURL(),
      title: wc.getTitle(),
      loadCode: result.code,
      loadDescription: result.description,
      error: result.error,
    };
  }

  async startCapture(input: {
    targetUrl?: string;
    collectorId?: string;
    authProfile?: string;
    captureEnv?: string;
  }): Promise<CaptureSession> {
    const activeRuns = this.capture.active();
    const existingSession = this.activeSession || activeRuns[0];
    if (existingSession) {
      this.activeSession = existingSession;
      return existingSession;
    }
    const wc = this.businessWebContents();
    const targetUrl = normalizeBrowserUrl(input.targetUrl || wc.getURL());
    if (!targetUrl || targetUrl === "about:blank") throw new Error("open a target URL before starting capture");
    const auth = await this.ensureAuthReady({ targetUrl, authProfile: input.authProfile });
    const [viewportWidth, viewportHeight] = this.window?.getContentSize() || [0, 0];
    const session = await this.capture.start({
      targetUrl,
      tabId: wc.id,
      collectorId: input.collectorId,
      authProfile: auth.profile_id,
      authStatus: auth.status,
      authVerifiedAt: auth.verified_at,
      captureEnv: input.captureEnv,
      clientVersion: "autorecipe-electron-ts/0.1.0",
      viewportWidth,
      viewportHeight,
    });
    this.activeSession = session;
    this.lastAuthInterruptEventKey = undefined;
    wc.send("autorecipe:capture-started", {
      sessionId: session.sessionId,
      runId: session.runId,
      tabId: session.tabId,
    });
    await this.captureVisualSnapshot(session, "start");
    this.startSnapshotLoop();
    return session;
  }

  async verifyAuthState(input: AuthStateInput = {}): Promise<AuthVerification> {
    const wc = this.businessWebContents();
    const currentUrl = wc.getURL();
    const targetUrl = normalizeBrowserUrl(input.targetUrl || currentUrl);
    const targetProvided = typeof input.targetUrl === "string" && input.targetUrl.trim() !== "";
    if (!targetUrl || targetUrl === "about:blank") throw new Error("open a target URL before verifying auth state");

    const shouldLoadTarget = ((!currentUrl || currentUrl === "about:blank") && targetUrl !== "about:blank")
      || shouldNavigateForAuthTarget({ currentUrl, targetUrl, targetProvided });
    if (shouldLoadTarget) {
      const navigation = await waitForNavigation(wc, async () => {
        await wc.loadURL(targetUrl);
      });
      if (!navigation.success) {
        throw new Error(`auth blocked: ${navigation.error || "target page failed to load"}`);
      }
    } else if (wc.isLoading()) {
      await waitForPageReady(wc);
    }

    const snapshot = await collectAuthSnapshot(wc);
    const systemKey = systemKeyFromUrl(snapshot.url || targetUrl);
    const profileId = input.authProfile || "default";
    const verification = analyzeAuthSnapshot({
      profileId,
      systemKey,
      url: snapshot.url || targetUrl,
      title: snapshot.title,
      text: snapshot.text,
      selectors: snapshot.selectors,
      storageKeys: snapshot.storageKeys,
    });

    await this.store.saveAuthProfile({
      profile_id: verification.profile_id,
      system_key: verification.system_key,
      entry_url: targetUrl,
      login_url: verification.status === "required" ? verification.verified_url : "",
      browser_partition: this.options.browserPartition,
      cookie_scope: hostFromUrl(snapshot.url || targetUrl),
      status: verification.status,
      last_verified_at: verification.verified_at,
      verified_url: verification.verified_url,
      signals: verification.signals,
    });

    return verification;
  }

  async ensureAuthReady(input: AuthStateInput = {}): Promise<AuthVerification> {
    let auth: AuthVerification;
    try {
      auth = await this.verifyAuthState(input);
    } catch (error) {
      this.ensureBusinessViewVisible();
      throw error;
    }
    // Allow capture for ready, not_required, or unknown (public pages without clear auth signals)
    if (auth.status === "required" || auth.status === "expired" || auth.status === "blocked") {
      this.ensureBusinessViewVisible();
      throw new Error(`auth ${auth.status}: ${auth.reason || "login required before capture"}`);
    }
    return auth;
  }

  async stopCapture(): Promise<Record<string, unknown>> {
    const currentSession = this.activeSession;
    const activeRuns = this.capture.active();
    const sessions = currentSession
      ? [currentSession, ...activeRuns.filter((session) => session.sessionId !== currentSession.sessionId)]
      : activeRuns;
    if (!sessions.length) throw new Error("no active capture session");
    for (const session of sessions) {
      await this.captureVisualSnapshot(session, "stop");
    }
    this.stopSnapshotLoop();
    this.activeSession = undefined;
    this.businessWebContents().send("autorecipe:capture-stopped");
    const results: Record<string, unknown>[] = [];
    for (const session of sessions) {
      results.push(await this.capture.stop(session.sessionId));
    }
    return {
      ...results[0],
      stopped_sessions: results.length,
      stopped: results,
    };
  }

  private layoutBusinessView(): void {
    if (!this.window || !this.view) return;
    const [width, height] = this.window.getContentSize();
    const bounds = this.businessViewBounds(width, height);
    if (!sameBounds(this.lastBusinessViewBounds, bounds)) {
      this.view.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      this.lastBusinessViewBounds = bounds;
    }
    this.view.setAutoResize({ width: false, height: false });
    this.applyBusinessViewZoom(bounds.width);
  }

  private businessViewBounds(width: number, height: number): BusinessViewBounds {
    return resolveBusinessViewBounds({
      width,
      height,
      visible: this.explorationVisible,
      sidebarExpanded: this.workspaceExpanded,
    });
  }

  private applyBusinessViewZoom(viewWidth: number): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    const zoom = businessViewZoom(viewWidth);
    if (this.lastBusinessViewZoom === zoom) return;
    this.view.webContents.setZoomFactor(zoom);
    this.lastBusinessViewZoom = zoom;
  }

  private async installBusinessPageChrome(): Promise<void> {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    try {
      if (this.scrollbarCssKey) {
        await this.view.webContents.removeInsertedCSS(this.scrollbarCssKey).catch(() => undefined);
      }
      this.scrollbarCssKey = await this.view.webContents.insertCSS(HORIZONTAL_FIT_SCROLL_CSS);
      // Auto-zoom to fit page content within viewport
      await this.view.webContents.executeJavaScript(`
        (function() {
          function applyAutoZoom() {
            const scrollWidth = document.documentElement.scrollWidth;
            const viewportWidth = window.innerWidth;
            if (scrollWidth > viewportWidth) {
              const zoom = viewportWidth / scrollWidth;
              document.documentElement.style.transformOrigin = 'top left';
              document.documentElement.style.transform = 'scale(' + zoom + ')';
              document.documentElement.style.width = (100 / zoom) + '%';
            } else {
              document.documentElement.style.transform = '';
              document.documentElement.style.width = '';
            }
          }
          applyAutoZoom();
          window.addEventListener('resize', applyAutoZoom);
          // Re-apply after dynamic content loads
          setTimeout(applyAutoZoom, 500);
          setTimeout(applyAutoZoom, 1500);
        })();
      `).catch(() => undefined);
    } catch {
      // Some pages may reject injected CSS during navigation; the capture flow should continue.
    }
  }

  private installIpc(): void {
    ipcMain.handle("autorecipe:open", async (_event, url: string) => {
      return this.open(String(url || ""));
    });
    ipcMain.handle("autorecipe:capture-start", async (_event, payload: Record<string, string>) => this.startCapture(payload || {}));
    ipcMain.handle("autorecipe:capture-stop", async () => this.stopCapture());
    ipcMain.handle("autorecipe:status", async () => {
      const runs = await this.store.listRuns();
      const latestRun = runs.at(-1);
      return {
        success: true,
        active: this.capture.active(),
        activeCapture: this.capture.active()[0] || null,
        knowledgeRoot: this.options.knowledgeRoot,
        workspaceRoot: this.store.root,
        miningRoot: this.store.miningRoot(),
        latestRun: latestRun ? {
          runId: latestRun.run_id,
          systemKey: latestRun.system_key,
          targetUrl: latestRun.entry_url || latestRun.url,
          currentUrl: latestRun.current_url || latestRun.url,
          updatedAt: latestRun.updated_at,
          authStatus: latestRun.auth_status,
          artifacts: latestRun.latest_assets,
        } : null,
        latestSystem: latestRun?.system_key || "",
        cdpEndpoint: this.cdpEndpoint(),
        currentUrl: this.view?.webContents.getURL() || "",
        browserViewBounds: this.view?.getBounds() || null,
        browserViewZoom: this.view?.webContents.getZoomFactor() || 1,
        browserViewPolicy: {
          horizontalFit: true,
          verticalScroll: true,
          stableZoom: true,
        },
        authProfiles: await this.store.listAuthProfiles(),
      };
    });
    ipcMain.on("autorecipe:capture-event", (_event, payload: unknown) => {
      const session = this.activeSession;
      if (!session) return;
      void this.capture.ingest(session.sessionId, payload).catch((error: unknown) => {
        console.error("[autorecipe] failed to ingest capture event", error);
      });
    });
    ipcMain.on("autorecipe:request-context", (_event, payload: unknown) => {
      const ctx = payload as { request_id?: string; url?: string; interaction_ref?: Record<string, unknown> };
      if (!ctx?.request_id || !ctx?.interaction_ref) return;
      this.pendingInteractionContexts.set(ctx.request_id, {
        url: ctx.url || "",
        interaction_ref: ctx.interaction_ref,
        receivedAtMs: Date.now(),
      });
      setTimeout(() => this.pendingInteractionContexts.delete(ctx.request_id!), 15000);
    });
  }

  private installNetworkCapture(): void {
    const ses = electronSession.fromPartition(this.options.browserPartition);
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (this.activeSession && details.webContentsId === this.activeSession.tabId) {
        this.pendingRequests.set(String(details.id), {
          startedAtMs: Date.now(),
          pageUrl: this.view?.webContents.getURL() || "",
          tabId: details.webContentsId,
        });
      }
      callback({});
    });
    ses.webRequest.onCompleted((details) => {
      const pending = this.pendingRequests.get(String(details.id));
      this.pendingRequests.delete(String(details.id));
      const session = this.activeSession;
      if (!pending || !session || details.webContentsId !== session.tabId) return;
      let interactionRef: Record<string, unknown> | undefined;
      const now = Date.now();
      for (const [key, ctx] of this.pendingInteractionContexts) {
        if (ctx.url && details.url.startsWith(ctx.url) && now - ctx.receivedAtMs < 2000) {
          interactionRef = ctx.interaction_ref;
          this.pendingInteractionContexts.delete(key);
          break;
        }
      }
      const event = toNetworkCompletedEvent({
        tabId: session.tabId,
        pageUrl: pending.pageUrl || this.view?.webContents.getURL() || "",
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        resourceType: details.resourceType,
        startedAtMs: pending.startedAtMs,
        completedAtMs: Date.now(),
        interactionRef,
      });
      if (!event) return;
      void this.capture.ingest(session.sessionId, event).catch((error: unknown) => {
        console.error("[autorecipe] failed to ingest network event", error);
      });
    });
  }

  private startSnapshotLoop(): void {
    this.stopSnapshotLoop();
    this.snapshotTimer = setInterval(() => {
      const session = this.activeSession;
      if (!session || !this.view) return;
      if (this.snapshotInFlight) return;
      this.snapshotInFlight = true;
      void this.captureVisualSnapshot(session, "timer").then(async () => {
        await this.verifyAuthDuringCapture(session, this.view?.webContents.getURL() || "");
      }).catch((error) => console.error("[autorecipe] snapshot failed", error))
        .finally(() => {
          this.snapshotInFlight = false;
        });
    }, PERFORMANCE_CAPTURE_POLICY.snapshotIntervalMs);
  }

  private async captureVisualSnapshot(session: CaptureSession, trigger: "start" | "timer" | "stop"): Promise<void> {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    const image = await this.view.webContents.capturePage();
    const fileName = `snapshot_${Date.now()}_${trigger}.png`;
    const snapshotDir = this.store.screenshotsDir(session.runId);
    const filePath = path.join(snapshotDir, fileName);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(filePath, image.toPNG());
    await this.capture.ingest(session.sessionId, {
      event_type: "visual_snapshot",
      url: this.view.webContents.getURL() || "",
      ts: new Date().toISOString(),
      payload: {
        tab_id: session.tabId,
        page_url: this.view.webContents.getURL() || "",
        storage_ref: filePath,
        trigger,
      },
    });
  }

  private async verifyAuthDuringCapture(session: CaptureSession, pageUrl: string): Promise<void> {
    try {
      const auth = await this.verifyAuthState({
        targetUrl: pageUrl,
        authProfile: session.run.auth_profile || "default",
      });
      if (!AUTH_INTERRUPT_STATUSES.has(auth.status)) return;

      const eventKey = [
        session.sessionId,
        auth.status,
        auth.verified_url || pageUrl,
        auth.reason || "",
      ].join("|");
      if (eventKey === this.lastAuthInterruptEventKey) return;
      this.lastAuthInterruptEventKey = eventKey;

      await this.capture.ingest(session.sessionId, {
        event_type: "auth_state_changed",
        url: auth.verified_url || pageUrl,
        ts: auth.verified_at || new Date().toISOString(),
        payload: {
          tab_id: session.tabId,
          page_url: auth.verified_url || pageUrl,
          auth_status: auth.status,
          reason: auth.reason || `auth_${auth.status}_during_capture`,
        },
      });
    } catch (error) {
      console.error("[autorecipe] auth verification during capture failed", error);
    }
  }

  private stopSnapshotLoop(): void {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
  }
}

type NavigationResult = {
  success: boolean;
  code?: number;
  description?: string;
  error?: string;
};

async function waitForNavigation(wc: WebContents, action: () => Promise<void>): Promise<NavigationResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: NavigationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off("did-finish-load", onFinish);
      wc.off("did-fail-load", onFail);
      wc.off("did-stop-loading", onStop);
      resolve(result);
    };
    const onFinish = () => finish({ success: true });
    const onStop = () => {
      const currentUrl = wc.getURL();
      if (currentUrl && currentUrl !== "about:blank") finish({ success: true });
    };
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      const currentUrl = wc.getURL();
      if (errorCode === -3 && currentUrl && currentUrl !== "about:blank") {
        finish({ success: true, code: errorCode, description: "navigation aborted after redirect" });
        return;
      }
      finish({
        success: false,
        code: errorCode,
        description: errorDescription,
        error: `Failed to load ${validatedURL || currentUrl}: ${errorDescription} (${errorCode})`,
      });
    };
    const timer = setTimeout(() => {
      const currentUrl = wc.getURL();
      finish({
        success: Boolean(currentUrl && currentUrl !== "about:blank"),
        error: currentUrl && currentUrl !== "about:blank" ? "" : "Navigation timed out before a page loaded.",
      });
    }, 30000);
    wc.on("did-finish-load", onFinish);
    wc.on("did-fail-load", onFail);
    wc.on("did-stop-loading", onStop);
    action().catch((error: unknown) => {
      const currentUrl = wc.getURL();
      finish({
        success: Boolean(currentUrl && currentUrl !== "about:blank"),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

async function waitForPageReady(wc: WebContents): Promise<void> {
  if (!wc.isLoading()) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off("did-finish-load", finish);
      wc.off("did-stop-loading", finish);
      wc.off("did-fail-load", finish);
      resolve();
    };
    const timer = setTimeout(finish, 15000);
    wc.on("did-finish-load", finish);
    wc.on("did-stop-loading", finish);
    wc.on("did-fail-load", finish);
  });
}

async function collectAuthSnapshot(wc: WebContents): Promise<PageAuthSnapshot> {
  const fallback = {
    url: wc.getURL(),
    title: wc.getTitle(),
    text: "",
    selectors: [],
    storageKeys: [],
  };
  try {
    const snapshot = await wc.executeJavaScript(`
      (() => {
        const selectorCandidates = [
          "main",
          "[role=\\"main\\"]",
          "#app",
          "#root",
          "[data-app-shell]",
          "[data-testid=\\"app-shell\\"]",
          "[data-testid=\\"user-menu\\"]",
          "[aria-label=\\"user menu\\"]",
          "[data-user-menu]",
          ".user-menu",
          "#user-menu",
          "nav",
          "[role=\\"navigation\\"]",
          "[data-testid=\\"navigation\\"]",
          "[aria-label=\\"primary navigation\\"]"
        ];
        const selectors = selectorCandidates.filter((selector) => {
          try {
            return Boolean(document.querySelector(selector));
          } catch {
            return false;
          }
        });
        const storageKeys = [];
        for (const storage of [window.localStorage, window.sessionStorage]) {
          try {
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              if (key) storageKeys.push(key);
            }
          } catch {
            // Ignore storage blocked by page policy.
          }
        }
        return {
          url: window.location.href,
          title: document.title || "",
          text: (document.body?.innerText || "").slice(0, 4000),
          selectors,
          storageKeys: Array.from(new Set(storageKeys)).sort()
        };
      })()
    `, true) as Partial<PageAuthSnapshot>;
    return {
      url: String(snapshot.url || fallback.url),
      title: String(snapshot.title || fallback.title),
      text: String(snapshot.text || ""),
      selectors: Array.isArray(snapshot.selectors) ? snapshot.selectors.map(String) : [],
      storageKeys: Array.isArray(snapshot.storageKeys) ? snapshot.storageKeys.map(String) : [],
    };
  } catch {
    return fallback;
  }
}

function normalizeBrowserUrl(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith("about:")) return text;
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(text)) return `http://${text}`;
  return `https://${text}`;
}

function sameBounds(left: BusinessViewBounds | undefined, right: BusinessViewBounds): boolean {
  return Boolean(left)
    && left?.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}
