import {
  CaptureEventSchema,
  finalizeCapture,
  AuthStatus,
  KnowledgeStore,
  mergeSystem,
  normalizeIdentifier,
  RunContext,
  utcNowIso,
} from "@autorecipe/knowledge-core";
import type { LLMConfig } from "@autorecipe/knowledge-core";
import { randomBytes } from "node:crypto";

export type StartCaptureInput = {
  targetUrl: string;
  tabId: number;
  collectorId?: string;
  authProfile?: string;
  authStatus?: AuthStatus;
  authVerifiedAt?: string;
  captureEnv?: string;
  clientVersion?: string;
  goal?: string;
  viewportWidth?: number;
  viewportHeight?: number;
};

export type CaptureSession = {
  sessionId: string;
  runId: string;
  tabId: number;
  targetUrl: string;
  systemKey: string;
  status: "active" | "stopping" | "merged" | "quarantine" | "interrupted_auth_expired";
  run: RunContext;
};

type AuthInterrupt = {
  status: Extract<AuthStatus, "required" | "expired" | "blocked">;
  reason: string;
  verifiedAt: string;
  verifiedUrl: string;
};

const AUTH_INTERRUPT_STATUSES = new Set<AuthStatus>(["required", "expired", "blocked"]);
const AUTH_MERGEABLE_STATUSES = new Set<AuthStatus>(["ready", "not_required", "unknown"]);

export class CaptureSessionManager {
  private readonly sessions = new Map<string, CaptureSession>();

  constructor(private readonly store: KnowledgeStore, private readonly llmConfig?: LLMConfig) {}

  async start(input: StartCaptureInput): Promise<CaptureSession> {
    const run = await this.store.createRun({
      targetUrl: input.targetUrl,
      collectorId: input.collectorId,
      authProfile: input.authProfile,
      authStatus: input.authStatus,
      authVerifiedAt: input.authVerifiedAt,
      captureEnv: input.captureEnv,
      clientVersion: input.clientVersion,
      goal: input.goal,
      uploadPolicy: {
        browser_runtime: "electron_chromium",
        webcontents_id: input.tabId,
        client_platform: process.platform,
        viewport_width: input.viewportWidth,
        viewport_height: input.viewportHeight,
      },
    });
    const session: CaptureSession = {
      sessionId: `sess_${cryptoRandom(10)}`,
      runId: run.run_id,
      tabId: input.tabId,
      targetUrl: input.targetUrl,
      systemKey: run.system_key,
      status: "active",
      run,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async ingest(sessionId: string, event: unknown): Promise<{ accepted: boolean; reason: string }> {
    const session = this.requireSession(sessionId);
    const parsed = CaptureEventSchema.parse(event);
    const payload = parsed.payload || {};
    const tabId = Number(payload.tab_id ?? payload.bound_tab_id ?? session.tabId);
    const type = parsed.event_type.toLowerCase();
    if (["ui_click", "ui_input", "ui_change", "ui_submit", "layout_snapshot", "page_loaded", "url_change"].includes(type) && tabId !== session.tabId) {
      return { accepted: false, reason: "tab_mismatch" };
    }
    await this.store.appendEvents(session.runId, [{
      ...parsed,
      run_id: session.runId,
      ts: parsed.ts || utcNowIso(),
      payload: {
        ...payload,
        tab_id: payload.tab_id ?? session.tabId,
      },
    }]);
    return { accepted: true, reason: "kept" };
  }

  async stop(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    session.status = "stopping";
    const authInterrupt = this.initialAuthInterrupt(session) ?? await this.findAuthInterrupt(session.runId);
    const finalized = await finalizeCapture(this.store, session.runId, this.llmConfig);
    const hasInteractives = finalized.elementMap.elements.length > 0;
    const hasBusinessRequests = finalized.requestCatalog.requests.some((item: { request_category: string }) => item.request_category === "business");
    if (authInterrupt) {
      session.status = "interrupted_auth_expired";
      const run = await this.store.updateRunAuth(session.runId, {
        status: authInterrupt.status,
        verified_at: authInterrupt.verifiedAt,
        verified_url: authInterrupt.verifiedUrl,
        reason: authInterrupt.reason,
      });
      await this.store.writeRunManifest(run, {
        status: "interrupted_auth_expired",
        auth: {
          status: authInterrupt.status,
          verified_at: authInterrupt.verifiedAt,
          verified_url: authInterrupt.verifiedUrl,
          reason: authInterrupt.reason,
        },
      });
    } else {
      session.status = isMergeableAuthStatus(session.run.auth_status) && hasInteractives && hasBusinessRequests ? "merged" : "quarantine";
      if (session.status === "quarantine") {
        await this.store.writeRunManifest(session.run, { status: "quarantine" });
      }
    }
    const merged = session.status === "merged" ? await mergeSystem(this.store, session.systemKey, this.llmConfig) : {};
    const runDir = this.store.runDir(session.runId);
    const systemDir = this.store.systemDir(session.systemKey);
    this.sessions.delete(sessionId);
    return {
      success: true,
      session_id: session.sessionId,
      run_id: session.runId,
      system_key: session.systemKey,
      status: session.status,
      workspace_root: this.store.root,
      mining_root: this.store.miningRoot(),
      run_dir: runDir,
      system_dir: session.status === "merged" ? systemDir : "",
      artifacts: {
        manifest: this.store.runManifestPath(session.runId),
        evidence_index: this.store.artifactPath(session.runId, "evidence_index"),
        page_map: this.store.artifactPath(session.runId, "page_map"),
        business_catalog: this.store.artifactPath(session.runId, "business_catalog"),
        element_map: this.store.artifactPath(session.runId, "element_map"),
        request_catalog: this.store.artifactPath(session.runId, "request_catalog"),
        action_trace: this.store.artifactPath(session.runId, "action_trace"),
        semantic_annotations: this.store.artifactPath(session.runId, "semantic_annotations"),
        action_rules: this.store.artifactPath(session.runId, "action_rules"),
        recipe_pack: this.store.artifactPath(session.runId, "recipe_pack"),
        summary: this.store.artifactPath(session.runId, "summary"),
      },
      finalized: {
        map_pages: finalized.pageMap.pages.length,
        interactives: finalized.elementMap.elements.length,
        requests: finalized.requestCatalog.requests.length,
        rule_steps: finalized.recipePack.steps.length,
      },
      merged,
    };
  }

  active(): CaptureSession[] {
    return [...this.sessions.values()];
  }

  private requireSession(sessionId: string): CaptureSession {
    const session = this.sessions.get(normalizeIdentifier(sessionId, ""));
    if (!session) throw new Error(`capture session not found: ${sessionId}`);
    return session;
  }

  private async findAuthInterrupt(runId: string): Promise<AuthInterrupt | undefined> {
    const events = await this.store.loadEvents(runId);
    let interrupt: AuthInterrupt | undefined;
    for (const rawEvent of events) {
      const event = CaptureEventSchema.parse(rawEvent);
      if (event.event_type.toLowerCase() !== "auth_state_changed") continue;
      const status = authInterruptStatus(event.payload.auth_status);
      if (!status) continue;
      interrupt = {
        status,
        reason: String(event.payload.reason || `auth_${status}_during_capture`),
        verifiedAt: event.ts || utcNowIso(),
        verifiedUrl: String(event.payload.verified_url || event.payload.page_url || event.url || ""),
      };
    }
    return interrupt;
  }

  private initialAuthInterrupt(session: CaptureSession): AuthInterrupt | undefined {
    const status = authInterruptStatus(session.run.auth_status);
    if (!status) return undefined;
    return {
      status,
      reason: `auth_${status}_at_capture_start`,
      verifiedAt: session.run.auth_verified_at || session.run.created_at || utcNowIso(),
      verifiedUrl: session.run.current_url || session.run.entry_url || session.targetUrl,
    };
  }
}

function cryptoRandom(size: number): string {
  return randomBytes(Math.ceil(size / 2)).toString("hex").slice(0, size);
}

function authInterruptStatus(value: unknown): AuthInterrupt["status"] | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.toLowerCase() as AuthStatus;
  return AUTH_INTERRUPT_STATUSES.has(status) ? status as AuthInterrupt["status"] : undefined;
}

function isMergeableAuthStatus(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return AUTH_MERGEABLE_STATUSES.has(value.toLowerCase() as AuthStatus);
}
