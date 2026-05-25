import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AuthProfile,
  AuthProfileInput,
  AuthProfileSchema,
  AuthStatus,
  AuthVerification,
  AuthVerificationInput,
  AuthVerificationSchema,
  RunContext,
  RunContextSchema,
} from "./schemas.js";
import {
  hostFromUrl,
  hostSuffix,
  newRunId,
  normalizeIdentifier,
  systemKeyFromUrl,
  utcNowIso,
} from "./utils.js";

export class KnowledgeStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.miningRoot(), { recursive: true });
    await mkdir(this.authRoot(), { recursive: true });
    await mkdir(this.authProfilesRoot(), { recursive: true });
    await mkdir(path.join(this.miningRoot(), "runs"), { recursive: true });
    await mkdir(path.join(this.miningRoot(), "sessions"), { recursive: true });
    await mkdir(path.join(this.miningRoot(), "systems"), { recursive: true });
    await mkdir(path.join(this.miningRoot(), "latest", "runs"), { recursive: true });
    await mkdir(path.join(this.miningRoot(), "latest", "artifacts"), { recursive: true });
    await mkdir(path.join(this.miningRoot(), "exports"), { recursive: true });
    await mkdir(path.join(this.miningRoot(), "trash"), { recursive: true });
    await mkdir(path.join(this.root, "personal-space", "events"), { recursive: true });
    await mkdir(path.join(this.root, "personal-space", "sessions"), { recursive: true });
    await mkdir(path.join(this.root, "personal-space", "notebook"), { recursive: true });
    await this.ensureWorkspaceManifest();
    await this.writeMiningIndex();
  }

  miningRoot(): string {
    return path.join(this.root, "mining");
  }

  authRoot(): string {
    return path.join(this.miningRoot(), "auth");
  }

  authProfilesRoot(): string {
    return path.join(this.authRoot(), "profiles");
  }

  authProfilesIndexPath(): string {
    return path.join(this.authRoot(), "profiles.json");
  }

  authProfilePath(profileId: string): string {
    return path.join(this.authProfilesRoot(), `${normalizeIdentifier(profileId, "default")}.json`);
  }

  runDir(runId: string): string {
    return this.existingOrDefaultRunDir(runId);
  }

  rawDir(runId: string): string {
    return path.join(this.runDir(runId), "raw");
  }

  screenshotsDir(runId: string): string {
    return path.join(this.rawDir(runId), "screenshots");
  }

  eventLogPath(runId: string): string {
    return path.join(this.rawDir(runId), "events.jsonl");
  }

  artifactPath(runId: string, artifactType: string): string {
    return path.join(this.runDir(runId), "artifacts", `${artifactType}.json`);
  }

  systemDir(systemKey: string): string {
    return path.join(this.miningRoot(), "systems", normalizeIdentifier(systemKey));
  }

  findSystemDir(systemKey: string): string {
    const normalized = normalizeIdentifier(systemKey);
    const primary = path.join(this.miningRoot(), "systems", normalized);
    const legacy = path.join(this.root, "systems", normalized);
    return existsSync(primary) || !existsSync(legacy) ? primary : legacy;
  }

  runManifestPath(runId: string): string {
    return path.join(this.runDir(runId), "manifest.json");
  }

  async createRun(input: {
    targetUrl: string;
    goal?: string;
    collectorId?: string;
    authProfile?: string;
    authStatus?: AuthStatus;
    authVerifiedAt?: string;
    authInterruptReason?: string;
    captureEnv?: string;
    clientVersion?: string;
    uploadPolicy?: Record<string, unknown>;
    tenantId?: string;
  }): Promise<RunContext> {
    await this.ensureRoot();
    const runId = newRunId();
    const systemKey = systemKeyFromUrl(input.targetUrl);
    const host = hostFromUrl(input.targetUrl);
    const now = utcNowIso();
    const run = RunContextSchema.parse({
      run_id: runId,
      run_name: runId,
      url: input.targetUrl,
      entry_url: input.targetUrl,
      current_url: input.targetUrl,
      system_key: systemKey,
      goal: input.goal || "desktop_client_session",
      driver: "desktop_chromium",
      capture_mode: "desktop_client",
      tenant_id: normalizeIdentifier(input.tenantId || "default"),
      client_version: input.clientVersion || "",
      collector_id: normalizeIdentifier(input.collectorId || "desktop_client", "desktop_client"),
      auth_profile: normalizeIdentifier(input.authProfile || "", ""),
      auth_status: input.authStatus || "unknown",
      auth_verified_at: input.authVerifiedAt || "",
      auth_interrupt_reason: input.authInterruptReason || "",
      credential_scope: input.authProfile ? "profile" : "default_profile",
      capture_env: normalizeIdentifier(input.captureEnv || host || "default"),
      upload_policy: input.uploadPolicy || {},
      target_host: host,
      target_host_suffix: hostSuffix(host),
      latest_assets: {},
      consolidated: false,
      created_at: now,
      updated_at: now,
    });
    await mkdir(this.rawDir(runId), { recursive: true });
    await mkdir(this.screenshotsDir(runId), { recursive: true });
    await mkdir(path.join(this.runDir(runId), "artifacts"), { recursive: true });
    await writeFile(path.join(this.runDir(runId), "run.json"), JSON.stringify(run, null, 2), "utf8");
    await this.writeRunManifest(run, { status: "recording" });
    await writeFile(this.eventLogPath(runId), "", "utf8");
    await this.writeMiningIndex();
    return run;
  }

  async saveAuthProfile(input: AuthProfileInput): Promise<AuthProfile> {
    await this.ensureRoot();
    const now = utcNowIso();
    const profile = AuthProfileSchema.parse({
      ...input,
      profile_id: normalizeIdentifier(input.profile_id, "default"),
      system_key: normalizeIdentifier(input.system_key, "default"),
      entry_url: sanitizeAuthUrl(input.entry_url),
      login_url: sanitizeAuthUrl(input.login_url),
      verified_url: sanitizeAuthUrl(input.verified_url),
      signals: sanitizeAuthSignals(input.signals),
      updated_at: now,
    });
    await writeFile(this.authProfilePath(profile.profile_id), JSON.stringify(profile, null, 2), "utf8");
    await this.writeAuthProfilesIndex();
    return profile;
  }

  async loadAuthProfile(profileId: string): Promise<AuthProfile | undefined> {
    try {
      const payload = JSON.parse(await readFile(this.authProfilePath(profileId), "utf8"));
      return AuthProfileSchema.parse(payload);
    } catch {
      return undefined;
    }
  }

  async listAuthProfiles(): Promise<AuthProfile[]> {
    await this.ensureRoot();
    const names = await readdir(this.authProfilesRoot()).catch(() => []);
    const profiles: AuthProfile[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const profile = await this.loadAuthProfile(name.replace(/\.json$/, ""));
      if (profile) profiles.push(profile);
    }
    return profiles.sort((a, b) => a.profile_id.localeCompare(b.profile_id));
  }

  async writeAuthProfilesIndex(): Promise<void> {
    const profiles = await this.listAuthProfiles();
    await writeFile(this.authProfilesIndexPath(), JSON.stringify({
      schema_version: "v1",
      artifact_type: "auth_profiles_index",
      profiles: profiles.map((profile) => ({
        profile_id: profile.profile_id,
        system_key: profile.system_key,
        entry_url: profile.entry_url,
        status: profile.status,
        last_verified_at: profile.last_verified_at,
        updated_at: profile.updated_at,
      })),
      updated_at: utcNowIso(),
    }, null, 2), "utf8");
  }

  async loadRun(runId: string): Promise<RunContext> {
    const payload = JSON.parse(await readFile(path.join(this.runDir(runId), "run.json"), "utf8"));
    return RunContextSchema.parse(payload);
  }

  async saveRun(run: RunContext): Promise<void> {
    const next = { ...run, updated_at: utcNowIso() };
    await mkdir(this.runDir(run.run_id), { recursive: true });
    await writeFile(path.join(this.runDir(run.run_id), "run.json"), JSON.stringify(next, null, 2), "utf8");
    await this.writeRunManifest(next);
  }

  async updateRunAuth(runId: string, auth: AuthVerificationInput): Promise<RunContext> {
    const run = await this.loadRun(runId);
    const existingAuth = await this.loadRunManifestAuth(runId);
    const profileId = authValue(auth, "profile_id") ?? run.auth_profile ?? "default";
    const systemKey = authValue(auth, "system_key") ?? run.system_key ?? "default";
    const parsed = AuthVerificationSchema.parse({
      profile_id: profileId,
      system_key: systemKey,
      status: auth.status,
      verified_at: auth.verified_at ?? run.auth_verified_at,
      verified_url: sanitizeAuthUrl(auth.verified_url ?? run.current_url ?? run.url),
      reason: auth.reason ?? run.auth_interrupt_reason,
      signals: sanitizeAuthSignals(auth.signals),
      sensitive_values_stored: auth.sensitive_values_stored,
    });
    const next = RunContextSchema.parse({
      ...run,
      auth_profile: normalizeIdentifier(parsed.profile_id, ""),
      auth_status: parsed.status,
      auth_verified_at: parsed.verified_at,
      auth_interrupt_reason: parsed.reason,
    });
    const manifestVerification = AuthVerificationSchema.parse({
      profile_id: authValue(auth, "profile_id") ?? stringValue(existingAuth.profile_id) ?? next.auth_profile ?? "default",
      system_key: authValue(auth, "system_key") ?? run.system_key ?? "default",
      status: auth.status,
      verified_at: auth.verified_at ?? stringValue(existingAuth.verified_at) ?? next.auth_verified_at,
      verified_url: sanitizeAuthUrl(auth.verified_url ?? stringValue(existingAuth.verified_url) ?? next.current_url ?? next.url),
      reason: auth.reason ?? stringValue(existingAuth.reason) ?? next.auth_interrupt_reason,
      signals: sanitizeAuthSignals(auth.signals ?? (Array.isArray(existingAuth.signals) ? existingAuth.signals : undefined)),
      sensitive_values_stored: false,
    });
    await this.saveRun(next);
    await this.writeRunManifest(next, { auth: manifestAuth(next, manifestVerification) });
    return next;
  }

  async appendEvents(runId: string, events: unknown[]): Promise<number> {
    const file = this.eventLogPath(runId);
    const lines = events.map((event) => JSON.stringify(event)).join("\n");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, lines ? `${lines}\n` : "", { encoding: "utf8", flag: "a" });
    return events.length;
  }

  async loadEvents(runId: string): Promise<unknown[]> {
    const file = this.eventLogPath(runId);
    const text = await readFile(file, "utf8").catch(() => "");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }

  async saveArtifact(runId: string, artifactType: string, payload: unknown): Promise<{ runPath: string; latestPath: string }> {
    const runPath = this.artifactPath(runId, artifactType);
    const latestDir = path.join(this.miningRoot(), "latest", "artifacts", artifactType);
    const latestPath = path.join(latestDir, `${runId}.json`);
    await mkdir(path.dirname(runPath), { recursive: true });
    await mkdir(latestDir, { recursive: true });
    const body = JSON.stringify(payload, null, 2);
    await writeFile(runPath, body, "utf8");
    await writeFile(latestPath, body, "utf8");
    return { runPath, latestPath };
  }

  async loadArtifact<T = unknown>(runId: string, artifactType: string): Promise<T> {
    return JSON.parse(await readFile(this.artifactPath(runId, artifactType), "utf8")) as T;
  }

  async listRuns(systemKey?: string): Promise<RunContext[]> {
    await this.ensureRoot();
    const roots = [
      path.join(this.miningRoot(), "runs"),
      path.join(this.root, "captures", "runs"),
    ];
    const runs: RunContext[] = [];
    const seen = new Set<string>();
    for (const runsRoot of roots) {
      const names = await readdir(runsRoot).catch(() => []);
      for (const name of names) {
        if (seen.has(name)) continue;
        try {
          const run = await this.loadRun(name);
          seen.add(run.run_id);
          if (!systemKey || run.system_key === systemKey) runs.push(run);
        } catch {
          // Ignore incomplete run folders.
        }
      }
    }
    return runs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async writeRunManifest(run: RunContext, extra: Record<string, unknown> = {}): Promise<void> {
    const runDir = this.runDir(run.run_id);
    const artifactsDir = path.join(runDir, "artifacts");
    const existingAuth = await this.loadRunManifestAuth(run.run_id);
    const hasAuthExtra = Object.prototype.hasOwnProperty.call(extra, "auth");
    const artifactNames = await readdir(artifactsDir).catch(() => []);
    const artifacts = Object.fromEntries(
      artifactNames
        .filter((name) => name.endsWith(".json"))
        .map((name) => [name.replace(/\.json$/, ""), path.join("artifacts", name)]),
    );
    const uploadPolicy = run.upload_policy || {};
    const manifest = {
      schema_version: "v1",
      artifact_type: "mining_run_manifest",
      run_id: run.run_id,
      system_key: run.system_key,
      target_url: run.entry_url || run.url,
      current_url: run.current_url || run.url,
      collector_id: run.collector_id,
      auth_profile: run.auth_profile,
      capture_env: run.capture_env,
      viewport_width: uploadPolicy.viewport_width,
      viewport_height: uploadPolicy.viewport_height,
      status: extra.status || (run.latest_assets.recipe_pack ? "finalized" : "recording"),
      created_at: run.created_at,
      updated_at: run.updated_at,
      raw: {
        events: path.join("raw", "events.jsonl"),
        screenshots: path.join("raw", "screenshots"),
      },
      auth: manifestAuth(run, undefined, existingAuth),
      artifacts,
      ...extra,
    };
    if (hasAuthExtra) {
      manifest.auth = manifestAuth(run, authVerificationFromManifest(run, extra.auth));
    }
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(path.join(this.miningRoot(), "latest", "runs", `${run.run_id}.json`), JSON.stringify(manifest, null, 2), "utf8");
  }

  async writeSystemMetadata(systemKey: string, payload: {
    runCount: number;
    packPath?: string;
    runs?: RunContext[];
  }): Promise<void> {
    const normalized = normalizeIdentifier(systemKey);
    const runs = payload.runs ?? await this.listRuns(normalized);
    const systemDir = this.systemDir(normalized);
    await mkdir(systemDir, { recursive: true });
    const latestRun = [...runs].reverse()[0];
    const system = {
      schema_version: "v1",
      artifact_type: "mining_system",
      system_key: normalized,
      source_host: latestRun?.target_host || "",
      latest_run_id: latestRun?.run_id || "",
      run_count: payload.runCount,
      recipe_packs: payload.packPath ? [{ recipe_id: "captured_flow", path: path.relative(systemDir, payload.packPath) }] : [],
      updated_at: utcNowIso(),
    };
    const runsIndex = {
      schema_version: "v1",
      artifact_type: "mining_system_runs_index",
      system_key: normalized,
      runs: runs.map((run) => ({
        run_id: run.run_id,
        target_url: run.entry_url || run.url,
        current_url: run.current_url || run.url,
        created_at: run.created_at,
        updated_at: run.updated_at,
        artifacts: run.latest_assets,
      })),
    };
    await writeFile(path.join(systemDir, "system.json"), JSON.stringify(system, null, 2), "utf8");
    await writeFile(path.join(systemDir, "runs_index.json"), JSON.stringify(runsIndex, null, 2), "utf8");
    await this.writeMiningIndex();
  }

  async writeMiningIndex(): Promise<void> {
    const miningRoot = this.miningRoot();
    await mkdir(miningRoot, { recursive: true });
    const runsRoot = path.join(miningRoot, "runs");
    const systemsRoot = path.join(miningRoot, "systems");
    const runNames = await readdir(runsRoot).catch(() => []);
    const systemNames = await readdir(systemsRoot).catch(() => []);
    const runs: Array<Record<string, unknown>> = [];
    for (const name of runNames) {
      try {
        const run = await this.loadRun(name);
        runs.push({
          run_id: run.run_id,
          system_key: run.system_key,
          target_url: run.entry_url || run.url,
          current_url: run.current_url || run.url,
          created_at: run.created_at,
          updated_at: run.updated_at,
        });
      } catch {
        // Ignore incomplete run folders.
      }
    }
    const systems = systemNames.filter((name) => name && !name.startsWith(".")).map((systemKey) => ({
      system_key: systemKey,
      path: path.join("systems", systemKey),
    }));
    const latestRun = runs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
    await writeFile(path.join(miningRoot, "index.json"), JSON.stringify({
      schema_version: "v1",
      artifact_type: "mining_index",
      workspace_root: this.root,
      mining_root: miningRoot,
      latest_run_id: latestRun?.run_id || "",
      systems,
      runs,
      updated_at: utcNowIso(),
    }, null, 2), "utf8");
  }

  private async ensureWorkspaceManifest(): Promise<void> {
    const file = path.join(this.root, "workspace.json");
    if (existsSync(file)) return;
    await mkdir(this.root, { recursive: true });
    await writeFile(file, JSON.stringify({
      schema_version: "v1",
      artifact_type: "autorecipe_workspace",
      workspace_id: "default",
      created_at: utcNowIso(),
      directories: {
        personal_space: "personal-space",
        mining: "mining",
      },
    }, null, 2), "utf8");
  }

  private existingOrDefaultRunDir(runId: string): string {
    const primary = path.join(this.miningRoot(), "runs", runId);
    const legacy = path.join(this.root, "captures", "runs", runId);
    return existsSync(primary) || !existsSync(legacy) ? primary : legacy;
  }

  private async loadRunManifestAuth(runId: string): Promise<Record<string, unknown>> {
    try {
      const manifest = JSON.parse(await readFile(this.runManifestPath(runId), "utf8"));
      return typeof manifest.auth === "object" && manifest.auth ? manifest.auth : {};
    } catch {
      return {};
    }
  }
}

function manifestAuth(
  run: RunContext,
  verification?: AuthVerification,
  existingAuth: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    profile_id: verification?.profile_id ?? stringValue(existingAuth.profile_id) ?? run.auth_profile,
    status: verification?.status ?? stringValue(existingAuth.status) ?? run.auth_status ?? "unknown",
    verified_at: verification?.verified_at ?? stringValue(existingAuth.verified_at) ?? run.auth_verified_at ?? "",
    verified_url: sanitizeAuthUrl(verification?.verified_url ?? stringValue(existingAuth.verified_url) ?? run.current_url ?? run.url),
    reason: verification?.reason ?? stringValue(existingAuth.reason) ?? run.auth_interrupt_reason ?? "",
    signals: sanitizeAuthSignals(verification?.signals ?? existingAuth.signals),
    sensitive_values_stored: false,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function authValue(input: AuthVerificationInput, key: "profile_id" | "system_key"): string | undefined {
  return Object.prototype.hasOwnProperty.call(input, key) ? stringValue(input[key]) : undefined;
}

function authVerificationFromManifest(run: RunContext, value: unknown): AuthVerification | undefined {
  if (!value || typeof value !== "object") return undefined;
  const auth = value as Record<string, unknown>;
  const status = stringValue(auth.status) || run.auth_status || "unknown";
  return AuthVerificationSchema.parse({
    profile_id: stringValue(auth.profile_id) ?? run.auth_profile ?? "default",
    system_key: run.system_key || "default",
    status,
    verified_at: stringValue(auth.verified_at) ?? run.auth_verified_at ?? "",
    verified_url: sanitizeAuthUrl(stringValue(auth.verified_url) ?? run.current_url ?? run.url),
    reason: stringValue(auth.reason) ?? run.auth_interrupt_reason ?? "",
    signals: sanitizeAuthSignals(auth.signals),
    sensitive_values_stored: false,
  });
}

function sanitizeAuthSignals(signals: unknown): AuthProfile["signals"] {
  if (!Array.isArray(signals)) return [];
  const sanitized = AuthProfileSchema.shape.signals.safeParse(signals);
  if (!sanitized.success) return [];
  return sanitized.data.map((signal) => ({
    ...signal,
    name: redactSensitiveName(signal.name),
    detail: redactSensitiveDetail(signal.detail, signal.kind),
  }));
}

function redactSensitiveName(name: string): string {
  if (isSensitiveAuthSignalName(name)) return "[REDACTED]";
  return name;
}

function redactSensitiveDetail(detail: string, kind: string): string {
  if (isSensitiveAuthDetail(detail, kind)) return "[REDACTED]";
  return detail;
}

function isSensitiveAuthSignalName(name: string): boolean {
  if (!name) return false;
  return /(bearer|authorization|cookie|token|password|passwd|secret|refresh|credential|jwt|session[_-]?(id|token|secret)|sid)/i.test(name);
}

function isSensitiveAuthDetail(detail: string, kind: string): boolean {
  if (!detail) return false;
  return /(bearer|authorization|cookie|token|password|passwd|secret|session|refresh)/i.test(detail);
}

function sanitizeAuthUrl(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const withoutQueryOrHash = value.split(/[?#]/, 1)[0] || "";
    return sanitizeMalformedUrlUserinfo(withoutQueryOrHash);
  }
}

function sanitizeMalformedUrlUserinfo(value: string): string {
  const authorityStart = value.indexOf("//");
  if (authorityStart === -1) return value.includes("@") ? "" : value;

  const authorityOffset = authorityStart + 2;
  const pathStart = value.indexOf("/", authorityOffset);
  const authorityEnd = pathStart === -1 ? value.length : pathStart;
  const authority = value.slice(authorityOffset, authorityEnd);
  const userinfoEnd = authority.lastIndexOf("@");
  if (userinfoEnd === -1) return value;

  return `${value.slice(0, authorityOffset)}${authority.slice(userinfoEnd + 1)}${value.slice(authorityEnd)}`;
}
