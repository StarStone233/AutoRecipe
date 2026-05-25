import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeCapture, KnowledgeStore, mergeSystem } from "../dist/index.js";

test("creates mining workspace directories and run manifest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-mining-"));
  try {
    const store = new KnowledgeStore(dir);
    const run = await store.createRun({ targetUrl: "https://example.com/app", collectorId: "desktop" });

    const workspace = JSON.parse(await readFile(path.join(dir, "workspace.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(dir, "mining", "runs", run.run_id, "manifest.json"), "utf8"));
    const index = JSON.parse(await readFile(path.join(dir, "mining", "index.json"), "utf8"));

    assert.equal(workspace.directories.mining, "mining");
    assert.equal(manifest.artifact_type, "mining_run_manifest");
    assert.equal(manifest.status, "recording");
    assert.equal(manifest.raw.events, path.join("raw", "events.jsonl"));
    assert.equal(index.latest_run_id, run.run_id);
    assert.equal(store.eventLogPath(run.run_id), path.join(dir, "mining", "runs", run.run_id, "raw", "events.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists auth profile and writes auth metadata into run manifest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-auth-"));
  try {
    const store = new KnowledgeStore(dir);
    const profile = await store.saveAuthProfile({
      profile_id: "default",
      system_key: "secure_example",
      entry_url: "https://secure.example/app",
      login_url: "https://secure.example/login",
      browser_partition: "persist:autorecipe-default",
      cookie_scope: "secure.example",
      status: "ready",
      last_verified_at: "2026-05-22T00:00:00.000Z",
      verified_url: "https://secure.example/app",
      access_token: "secret-token-value",
      signals: [
        { kind: "url", name: "not_login_url", matched: true, confidence: 0.8 },
        { kind: "selector", name: "user_menu", matched: true, confidence: 0.9 },
      ],
    });
    const loaded = await store.loadAuthProfile("default");
    const profiles = await store.listAuthProfiles();
    const run = await store.createRun({
      targetUrl: "https://secure.example/app",
      authProfile: "default",
      authStatus: "ready",
      authVerifiedAt: "2026-05-22T00:00:00.000Z",
    });
    await store.updateRunAuth(run.run_id, {
      profile_id: "default",
      system_key: "secure_example",
      status: "expired",
      verified_at: "2026-05-22T01:00:00.000Z",
      verified_url: "https://secure.example/login",
      reason: "login_redirect",
      signals: [{ kind: "url", name: "login_url", matched: true, confidence: 0.9 }],
      sensitive_values_stored: false,
    });
    const profileFile = JSON.parse(await readFile(store.authProfilePath("default"), "utf8"));
    const index = JSON.parse(await readFile(store.authProfilesIndexPath(), "utf8"));
    const manifest = JSON.parse(await readFile(store.runManifestPath(run.run_id), "utf8"));

    assert.equal(profile.profile_id, "default");
    assert.equal(loaded?.system_key, "secure_example");
    assert.equal(profiles.length, 1);
    assert.equal(store.authRoot(), path.join(dir, "mining", "auth"));
    assert.equal(store.authProfilesRoot(), path.join(dir, "mining", "auth", "profiles"));
    assert.equal("access_token" in profileFile, false);
    assert.deepEqual(Object.keys(index.profiles[0]).sort(), [
      "entry_url",
      "last_verified_at",
      "profile_id",
      "status",
      "system_key",
      "updated_at",
    ]);
    assert.equal(manifest.auth.profile_id, "default");
    assert.equal(manifest.auth.status, "expired");
    assert.equal(manifest.auth.verified_at, "2026-05-22T01:00:00.000Z");
    assert.equal(manifest.auth.verified_url, "https://secure.example/login");
    assert.equal(manifest.auth.reason, "login_redirect");
    assert.equal(manifest.auth.sensitive_values_stored, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sanitizes auth profile and manifest urls before persistence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-auth-url-sanitize-"));
  const sensitiveUrl = "https://user:pass@secure.example/callback?code=secret-code#access_token=secret";
  const malformedSensitiveUrl = "https://user:pass@bad host/callback?code=secret-code#access_token=secret";
  try {
    const store = new KnowledgeStore(dir);
    await store.saveAuthProfile({
      profile_id: "default",
      system_key: "secure_example",
      entry_url: sensitiveUrl,
      login_url: sensitiveUrl,
      verified_url: sensitiveUrl,
      status: "ready",
    });
    const run = await store.createRun({ targetUrl: "https://secure.example/app", authProfile: "default" });
    await store.updateRunAuth(run.run_id, {
      profile_id: "default",
      system_key: "secure_example",
      status: "ready",
      verified_url: malformedSensitiveUrl,
      sensitive_values_stored: false,
    });

    const profileText = await readFile(store.authProfilePath("default"), "utf8");
    const profileIndexText = await readFile(store.authProfilesIndexPath(), "utf8");
    const manifestText = await readFile(store.runManifestPath(run.run_id), "utf8");
    const profile = JSON.parse(profileText);
    const manifest = JSON.parse(manifestText);

    for (const text of [profileText, profileIndexText, manifestText]) {
      assert.equal(text.includes("user:pass"), false);
      assert.equal(text.includes("secret-code"), false);
      assert.equal(text.includes("access_token"), false);
      assert.equal(text.includes("?"), false);
      assert.equal(text.includes("#"), false);
      assert.equal(text.includes("@"), false);
    }
    assert.equal(profile.entry_url, "https://secure.example/callback");
    assert.equal(profile.login_url, "https://secure.example/callback");
    assert.equal(profile.verified_url, "https://secure.example/callback");
    assert.equal(manifest.auth.verified_url, "https://bad host/callback");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preserves existing auth metadata on partial run auth update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-auth-partial-"));
  try {
    const store = new KnowledgeStore(dir);
    const run = await store.createRun({
      targetUrl: "https://secure.example/app",
      authProfile: "work_profile",
      authStatus: "ready",
      authVerifiedAt: "2026-05-22T00:00:00.000Z",
      authInterruptReason: "manual_login_verified",
    });

    await store.updateRunAuth(run.run_id, {
      profile_id: "work_profile",
      system_key: "secure_example",
      status: "expired",
      verified_at: "2026-05-22T00:00:00.000Z",
      verified_url: "https://secure.example/session-expired",
      reason: "session_expired_banner",
      signals: [{ kind: "text", name: "session_expired", matched: true, confidence: 0.88 }],
      sensitive_values_stored: false,
    });
    const updated = await store.updateRunAuth(run.run_id, { status: "expired" });
    const manifest = JSON.parse(await readFile(store.runManifestPath(run.run_id), "utf8"));

    assert.equal(updated.auth_profile, "work_profile");
    assert.equal(updated.auth_status, "expired");
    assert.equal(updated.auth_verified_at, "2026-05-22T00:00:00.000Z");
    assert.equal(updated.auth_interrupt_reason, "session_expired_banner");
    assert.equal(manifest.auth.profile_id, "work_profile");
    assert.equal(manifest.auth.status, "expired");
    assert.equal(manifest.auth.verified_at, "2026-05-22T00:00:00.000Z");
    assert.equal(manifest.auth.verified_url, "https://secure.example/session-expired");
    assert.equal(manifest.auth.reason, "session_expired_banner");
    assert.deepEqual(manifest.auth.signals, [
      { kind: "text", name: "session_expired", matched: true, confidence: 0.88, detail: "" },
    ]);

    await store.updateRunAuth(run.run_id, {
      status: "ready",
      verified_url: "",
    });
    const explicitEmptyManifest = JSON.parse(await readFile(store.runManifestPath(run.run_id), "utf8"));

    assert.equal(explicitEmptyManifest.auth.status, "ready");
    assert.equal(explicitEmptyManifest.auth.verified_url, "");

    const emptyProfile = await store.updateRunAuth(run.run_id, {
      profile_id: "",
      status: "ready",
    });
    const emptyProfileManifest = JSON.parse(await readFile(store.runManifestPath(run.run_id), "utf8"));

    assert.equal(emptyProfile.auth_profile, "");
    assert.equal(emptyProfileManifest.auth.profile_id, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preserves auth evidence when rewriting run manifest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-auth-rewrite-"));
  try {
    const store = new KnowledgeStore(dir);
    const run = await store.createRun({
      targetUrl: "https://secure.example/app",
      authProfile: "work_profile",
      authStatus: "ready",
      authVerifiedAt: "2026-05-22T00:00:00.000Z",
    });
    const updated = await store.updateRunAuth(run.run_id, {
      profile_id: "work_profile",
      system_key: "secure_example",
      status: "ready",
      verified_at: "2026-05-22T00:00:00.000Z",
      verified_url: "https://secure.example/dashboard",
      reason: "user_menu_present",
      signals: [{ kind: "selector", name: "user_menu", matched: true, confidence: 0.9, detail: "user-menu" }],
      sensitive_values_stored: false,
    });

    await store.saveRun({ ...updated, current_url: "https://secure.example/settings" });
    const manifest = JSON.parse(await readFile(store.runManifestPath(run.run_id), "utf8"));

    assert.equal(manifest.auth.verified_url, "https://secure.example/dashboard");
    assert.deepEqual(manifest.auth.signals, [
      { kind: "selector", name: "user_menu", matched: true, confidence: 0.9, detail: "user-menu" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redacts sensitive auth signal details before persistence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-auth-redact-"));
  try {
    const store = new KnowledgeStore(dir);
    await store.saveAuthProfile({
      profile_id: "default",
      system_key: "secure_example",
      entry_url: "https://secure.example/app",
      status: "ready",
      signals: [
        { kind: "storage", name: "session_storage", matched: true, confidence: 0.8, detail: "Bearer secret-token-value" },
        { kind: "cookie", name: "refresh_cookie", matched: true, confidence: 0.8, detail: "refresh_token=abc" },
        { kind: "url", name: "redirect_url", matched: true, confidence: 0.8, detail: "secret-token-value" },
      ],
    });
    const run = await store.createRun({ targetUrl: "https://secure.example/app", authProfile: "default" });
    await store.updateRunAuth(run.run_id, {
      profile_id: "default",
      system_key: "secure_example",
      status: "ready",
      signals: [
        { kind: "request", name: "authorization", matched: true, confidence: 0.9, detail: "Authorization: Bearer secret-token-value" },
        { kind: "text", name: "password_field", matched: true, confidence: 0.7, detail: "password=abc" },
        { kind: "selector", name: "secret_selector", matched: true, confidence: 0.6, detail: "secret-token-value" },
      ],
      sensitive_values_stored: false,
    });
    const profileFile = await readFile(store.authProfilePath("default"), "utf8");
    const manifestText = await readFile(store.runManifestPath(run.run_id), "utf8");
    const profile = JSON.parse(profileFile);
    const manifest = JSON.parse(manifestText);

    for (const text of [profileFile, manifestText]) {
      assert.equal(text.includes("secret-token-value"), false);
      assert.equal(text.includes("Bearer"), false);
      assert.equal(text.includes("refresh_token=abc"), false);
      assert.equal(text.includes("password=abc"), false);
      assert.equal(text.includes("abc"), false);
    }
    assert.equal(profile.signals.every((signal) => signal.detail.includes("[REDACTED]")), true);
    assert.equal(manifest.auth.signals.every((signal) => signal.detail.includes("[REDACTED]")), true);
    assert.equal(manifest.auth.sensitive_values_stored, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redacts sensitive auth signal names before persistence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-auth-name-redact-"));
  const forbidden = [
    "session_token_user_123_secret",
    "Authorization Bearer secret-token-value",
    "Authorization",
    "Bearer",
    "secret-token-value",
  ];
  try {
    const store = new KnowledgeStore(dir);
    await store.saveAuthProfile({
      profile_id: "default",
      system_key: "secure_example",
      entry_url: "https://secure.example/app",
      status: "ready",
      signals: [
        { kind: "storage", name: "session_token_user_123_secret", matched: true, confidence: 0.8, detail: "storage:sensitive" },
      ],
    });
    const run = await store.createRun({ targetUrl: "https://secure.example/app", authProfile: "default" });
    await store.updateRunAuth(run.run_id, {
      profile_id: "default",
      system_key: "secure_example",
      status: "ready",
      signals: [
        { kind: "request", name: "Authorization Bearer secret-token-value", matched: true, confidence: 0.9, detail: "request header present" },
      ],
      sensitive_values_stored: false,
    });

    const profileText = await readFile(store.authProfilePath("default"), "utf8");
    const manifestText = await readFile(store.runManifestPath(run.run_id), "utf8");
    const profile = JSON.parse(profileText);
    const manifest = JSON.parse(manifestText);

    for (const text of [profileText, manifestText]) {
      for (const value of forbidden) {
        assert.equal(text.includes(value), false);
      }
    }
    assert.equal(profile.signals[0].name, "[REDACTED]");
    assert.equal(manifest.auth.signals[0].name, "[REDACTED]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reads legacy captures runs without writing new runs there", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-mining-"));
  try {
    const legacyRunDir = path.join(dir, "captures", "runs", "run_legacy");
    await mkdir(legacyRunDir, { recursive: true });
    await writeFile(path.join(legacyRunDir, "run.json"), JSON.stringify({
      run_id: "run_legacy",
      run_name: "run_legacy",
      url: "https://legacy.example/app",
      entry_url: "https://legacy.example/app",
      current_url: "https://legacy.example/app",
      system_key: "legacy_example",
      created_at: "2026-05-16T00:00:00.000Z",
      updated_at: "2026-05-16T00:00:00.000Z",
    }, null, 2), "utf8");

    const store = new KnowledgeStore(dir);
    const runs = await store.listRuns();
    const newRun = await store.createRun({ targetUrl: "https://new.example/app" });

    assert.equal(runs.some((run) => run.run_id === "run_legacy"), true);
    assert.equal(store.runDir("run_legacy"), legacyRunDir);
    assert.equal(store.runDir(newRun.run_id).startsWith(path.join(dir, "mining", "runs")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes mining system metadata and runs index", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-mining-"));
  try {
    const store = new KnowledgeStore(dir);
    const run = await store.createRun({ targetUrl: "https://system.example/app" });
    const packPath = path.join(store.systemDir(run.system_key), "actions", "recipe_packs", "captured_flow.json");

    await mkdir(path.dirname(packPath), { recursive: true });
    await writeFile(packPath, JSON.stringify({ recipe_id: "captured_flow" }), "utf8");
    await store.writeSystemMetadata(run.system_key, { runCount: 1, packPath });

    const system = JSON.parse(await readFile(path.join(store.systemDir(run.system_key), "system.json"), "utf8"));
    const runsIndex = JSON.parse(await readFile(path.join(store.systemDir(run.system_key), "runs_index.json"), "utf8"));

    assert.equal(system.artifact_type, "mining_system");
    assert.equal(system.latest_run_id, run.run_id);
    assert.equal(system.recipe_packs[0].recipe_id, "captured_flow");
    assert.equal(runsIndex.runs[0].run_id, run.run_id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("finalizeCapture folds IME intermediate input into final text step", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-ime-fold-"));
  try {
    const store = new KnowledgeStore(dir);
    const run = await store.createRun({ targetUrl: "https://cn.bing.com", authStatus: "not_required" });
    const pageUrl = "https://cn.bing.com/";
    const inputPayload = {
      tab_id: 1,
      page_url: pageUrl,
      tag: "input",
      role: "textbox",
      region: "main_content",
      x_pct: 45,
      y_pct: 24,
      w_pct: 70,
      h_pct: 6,
      width: 700,
      height: 40,
    };

    await store.appendEvents(run.run_id, [
      {
        event_type: "page_loaded",
        url: pageUrl,
        ts: "2026-05-24T00:00:00.000Z",
        payload: { tab_id: 1, page_url: pageUrl },
      },
      {
        event_type: "ui_pointer_start",
        url: pageUrl,
        ts: "2026-05-24T00:00:00.200Z",
        payload: { ...inputPayload, label: "input", text: "input" },
      },
      {
        event_type: "ui_click",
        url: pageUrl,
        ts: "2026-05-24T00:00:00.300Z",
        payload: { ...inputPayload, label: "input", text: "input" },
      },
      {
        event_type: "ui_pointer_end",
        url: pageUrl,
        ts: "2026-05-24T00:00:00.400Z",
        payload: { ...inputPayload, label: "input", text: "input" },
      },
      {
        event_type: "ui_input",
        url: pageUrl,
        ts: "2026-05-24T00:00:01.000Z",
        payload: { ...inputPayload, label: "wuxi", text: "wuxi" },
      },
      {
        event_type: "ui_change",
        url: pageUrl,
        ts: "2026-05-24T00:00:01.500Z",
        payload: {
          tab_id: 1,
          page_url: pageUrl,
          tag: "bing-homepage-feed",
          label: "bing-homepage-feed",
          text: "bing-homepage-feed",
          region: "left_nav",
          x_pct: 50,
          y_pct: 295,
          width: 900,
          height: 3000,
        },
      },
      {
        event_type: "ui_input",
        url: pageUrl,
        ts: "2026-05-24T00:00:02.000Z",
        payload: { ...inputPayload, label: "无锡明天的天气zen'me'y", text: "无锡明天的天气zen'me'y" },
      },
      {
        event_type: "ui_keydown",
        url: pageUrl,
        ts: "2026-05-24T00:00:03.000Z",
        payload: { ...inputPayload, label: "无锡明天的天气zen'me'y", text: "无锡明天的天气zen'me'y", key: "Enter" },
      },
      {
        event_type: "ui_input",
        url: pageUrl,
        ts: "2026-05-24T00:00:04.000Z",
        payload: { ...inputPayload, label: "无锡明天的天气怎么样", text: "无锡明天的天气怎么样" },
      },
      {
        event_type: "ui_submit",
        url: pageUrl,
        ts: "2026-05-24T00:00:05.000Z",
        payload: { tab_id: 1, page_url: pageUrl, tag: "form", label: "form", region: "main_content", x_pct: 45, y_pct: 24 },
      },
      {
        event_type: "ui_submit",
        url: pageUrl,
        ts: "2026-05-24T00:00:05.050Z",
        payload: { tab_id: 1, page_url: pageUrl, tag: "form", label: "form", region: "main_content", x_pct: 45, y_pct: 24 },
      },
      {
        event_type: "ui_click",
        url: pageUrl,
        ts: "2026-05-24T00:00:05.100Z",
        payload: { ...inputPayload, label: "无锡明天的天气怎么样", text: "无锡明天的天气怎么样" },
      },
      {
        event_type: "network_completed",
        url: "https://cn.bing.com/search?q=%E6%97%A0%E9%94%A1%E6%98%8E%E5%A4%A9%E7%9A%84%E5%A4%A9%E6%B0%94%E6%80%8E%E4%B9%88%E6%A0%B7",
        ts: "2026-05-24T00:00:06.000Z",
        payload: {
          tab_id: 1,
          page_url: pageUrl,
          url: "https://cn.bing.com/search?q=%E6%97%A0%E9%94%A1%E6%98%8E%E5%A4%A9%E7%9A%84%E5%A4%A9%E6%B0%94%E6%80%8E%E4%B9%88%E6%A0%B7",
          method: "GET",
          status_code: 200,
          resource_type: "xhr",
        },
      },
    ]);

    const result = await finalizeCapture(store, run.run_id);
    const stepTexts = result.recipePack.steps.map((step) => step.text);
    const stepActions = result.recipePack.steps.map((step) => step.action);
    const fillSteps = result.recipePack.steps.filter((step) => step.action === "fill_text");
    const submitSteps = result.recipePack.steps.filter((step) => step.action === "submit_form");
    const keySteps = result.recipePack.steps.filter((step) => step.action === "key_press");
    const searchRequest = result.requestCatalog.requests.find((request) => request.path_template === "/search");

    assert.equal(fillSteps.length, 1);
    assert.equal(fillSteps[0].text, "无锡明天的天气怎么样");
    assert.equal(submitSteps.length, 1);
    assert.equal(stepActions.includes("click_text"), false);
    assert.equal(keySteps.length, 0);
    assert.equal(stepTexts.includes("input"), false);
    assert.equal(stepTexts.includes("wuxi"), false);
    assert.equal(stepTexts.includes("无锡明天的天气zen'me'y"), false);
    assert.equal(stepTexts.includes("bing-homepage-feed"), false);
    assert.equal(result.actionTrace.actions.some((action) => action.label === "wuxi"), false);
    assert.equal(result.actionTrace.actions.some((action) => action.label === "bing-homepage-feed"), false);
    assert.equal(searchRequest?.page_id, "cn_bing_com");
    assert.equal(searchRequest?.page_url, pageUrl);
    assert.deepEqual(searchRequest?.page_urls, [pageUrl]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("finalizeCapture keeps learned data inside site scope and groups secondary surfaces", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-scope-surface-"));
  try {
    const store = new KnowledgeStore(dir);
    const run = await store.createRun({ targetUrl: "https://cn.bing.com", authStatus: "not_required" });
    const pageUrl = "https://cn.bing.com/";
    const externalUrl = "https://login.live.com/oauth";

    await store.appendEvents(run.run_id, [
      {
        event_type: "page_loaded",
        url: pageUrl,
        ts: "2026-05-24T02:00:00.000Z",
        payload: { tab_id: 2, page_url: pageUrl },
      },
      {
        event_type: "visual_snapshot",
        url: pageUrl,
        ts: "2026-05-24T02:00:00.200Z",
        payload: { tab_id: 2, page_url: pageUrl, storage_ref: path.join(dir, "bing-shot.png") },
      },
      {
        event_type: "ui_click",
        url: pageUrl,
        ts: "2026-05-24T02:00:01.000Z",
        payload: {
          tab_id: 2,
          page_url: pageUrl,
          label: "搜索选项",
          region: "top_bar",
          x_pct: 72,
          y_pct: 18,
          w_pct: 8,
          h_pct: 5,
          surface_id: "surface_search_options",
          surface_kind: "secondary_surface",
          surface_label: "搜索选项弹窗",
          surface_bbox_in_viewport: { x: 62, y: 10, width: 30, height: 35 },
          surface_bbox: { x: 20, y: 25, width: 12, height: 10 },
        },
      },
      {
        event_type: "network_completed",
        url: "https://cn.bing.com/search?q=test",
        ts: "2026-05-24T02:00:02.000Z",
        payload: {
          tab_id: 2,
          page_url: pageUrl,
          url: "https://cn.bing.com/search?q=test",
          method: "GET",
          status_code: 200,
          resource_type: "xhr",
        },
      },
      {
        event_type: "network_completed",
        url: "https://login.live.com/api/session",
        ts: "2026-05-24T02:00:02.100Z",
        payload: {
          tab_id: 2,
          page_url: pageUrl,
          url: "https://login.live.com/api/session",
          method: "POST",
          status_code: 200,
          resource_type: "xhr",
        },
      },
      {
        event_type: "page_loaded",
        url: externalUrl,
        ts: "2026-05-24T02:00:03.000Z",
        payload: { tab_id: 2, page_url: externalUrl },
      },
      {
        event_type: "ui_click",
        url: externalUrl,
        ts: "2026-05-24T02:00:04.000Z",
        payload: { tab_id: 2, page_url: externalUrl, label: "登录", region: "main_content", x_pct: 50, y_pct: 50 },
      },
    ]);

    const result = await finalizeCapture(store, run.run_id);
    const secondary = result.pageMap.surfaces.find((surface) => surface.surface_id === "surface_search_options");

    assert.deepEqual(result.pageMap.url_history, [pageUrl]);
    assert.equal(result.pageMap.pages.some((page) => page.page_url === externalUrl), false);
    assert.deepEqual(result.requestCatalog.requests.map((request) => request.host), ["cn.bing.com"]);
    assert.equal(result.evidenceIndex.raw_event_count, 7);
    assert.ok(secondary);
    assert.equal(secondary.surface_kind, "secondary_surface");
    assert.equal(secondary.label, "搜索选项弹窗");
    assert.deepEqual(secondary.surface_bbox_in_viewport, { x: 62, y: 10, width: 30, height: 35 });
    assert.deepEqual(secondary.heat_zones[0].bbox_pct, { x: 20, y: 25, width: 12, height: 10 });
    assert.equal(result.actionTrace.actions[0].surface_id, "surface_search_options");
    assert.equal(result.actionTrace.actions[0].surface_kind, "secondary_surface");
    assert.equal(result.elementMap.elements.some((element) => element.label === "登录"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeSystem excludes interrupted auth runs from baseline and run count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-merge-auth-skip-"));
  try {
    const store = new KnowledgeStore(dir);
    const interrupted = await store.createRun({
      targetUrl: "https://secure.example/login",
      authStatus: "expired",
    });
    await writeFinalizedArtifacts(store, interrupted.run_id, {
      systemKey: interrupted.system_key,
      pageUrl: "https://secure.example/login",
      label: "Login",
    });
    await store.saveRun({
      ...interrupted,
      current_url: "https://secure.example/login",
      latest_assets: {
        recipe_pack: store.artifactPath(interrupted.run_id, "recipe_pack"),
      },
    });
    await store.writeRunManifest(interrupted, { status: "interrupted_auth_expired" });

    const successful = await store.createRun({
      targetUrl: "https://secure.example/app",
      authStatus: "ready",
    });
    await writeFinalizedArtifacts(store, successful.run_id, {
      systemKey: successful.system_key,
      pageUrl: "https://secure.example/app",
      label: "Search",
    });
    await store.saveRun({
      ...successful,
      current_url: "https://secure.example/app",
      latest_assets: {
        recipe_pack: store.artifactPath(successful.run_id, "recipe_pack"),
      },
    });
    await store.writeRunManifest(successful, { status: "finalized" });

    const result = await mergeSystem(store, successful.system_key);
    const baseline = JSON.parse(await readFile(path.join(result.systemDir, "knowledge", "page_map.json"), "utf8"));
    const system = JSON.parse(await readFile(path.join(result.systemDir, "system.json"), "utf8"));
    const runsIndex = JSON.parse(await readFile(path.join(result.systemDir, "runs_index.json"), "utf8"));

    assert.equal(result.runCount, 1);
    assert.equal(system.run_count, 1);
    assert.deepEqual(baseline.pages.map((page) => page.page_url), ["https://secure.example/app"]);
    assert.equal(JSON.stringify(baseline).includes("https://secure.example/login"), false);
    assert.deepEqual(runsIndex.runs.map((run) => run.run_id), [successful.run_id]);
    assert.equal(JSON.stringify(runsIndex).includes("https://secure.example/login"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("synthesizeCapabilities generates operation manual from business modules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-capabilities-"));
  try {
    const store = new KnowledgeStore(dir);
    const run = await store.createRun({
      targetUrl: "https://example.com/app",
      authStatus: "ready",
    });
    await writeFinalizedArtifacts(store, run.run_id, {
      systemKey: run.system_key,
      pageUrl: "https://example.com/app",
      label: "Search",
      modules: [{
        module_id: "search_module",
        title: "搜索",
        level: 1,
        source_region: "main_content",
        pages: ["app"],
        element_ids: ["search_btn"],
        heat_zone_ids: [],
        request_signatures: [],
        actions: [{
          action_id: "act_1",
          label: "搜索",
          page_id: "app",
          element_id: "search_btn",
          request_signatures: [],
          evidence_refs: [],
        }],
        entry_actions: [],
        exit_actions: [],
        evidence_refs: [],
        confidence: 0.8,
      }],
    });
    await store.saveRun({
      ...run,
      current_url: "https://example.com/app",
      latest_assets: {
        recipe_pack: store.artifactPath(run.run_id, "recipe_pack"),
      },
    });
    await store.writeRunManifest(run, { status: "finalized" });

    const result = await mergeSystem(store, run.system_key);
    const manual = JSON.parse(await readFile(path.join(result.systemDir, "knowledge", "operation_manual.json"), "utf8"));

    assert.equal(manual.artifact_type, "operation_manual");
    assert.equal(manual.schema_version, "v1");
    assert.equal(manual.system_key, run.system_key);
    assert.equal(manual.capabilities.length, 1);
    assert.equal(manual.capabilities[0].name, "搜索");
    assert.equal(manual.capabilities[0].capability_id, "search_module");
    assert.equal(manual.capabilities[0].steps.length, 1);
    assert.equal(manual.capabilities[0].steps[0].action, "fill");
    assert.equal(manual.capabilities[0].observation_count, 1);
    assert.ok(manual.capabilities[0].confidence >= 0.8);
    assert.ok(manual.source_run_count >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeFinalizedArtifacts(store, runId, { systemKey, pageUrl, label, modules, actionRules }) {
  const pageId = label.toLowerCase();
  const elementId = `${systemKey}:${pageId}:main_content:${label}`;
  await store.saveArtifact(runId, "evidence_index", {
    generated_at: "2026-05-22T00:00:00.000Z",
    artifact_type: "evidence_index",
    system_key: systemKey,
    events: [],
    screenshots: [],
    raw_event_count: 1,
  });
  await store.saveArtifact(runId, "page_map", {
    generated_at: "2026-05-22T00:00:00.000Z",
    schema_version: "v1",
    producer: "test",
    artifact_type: "page_map",
    source_system: systemKey,
    source_url: pageUrl,
    pages: [{
      page_url: pageUrl,
      page_id: pageId,
      entry_url: pageUrl,
      page_host: "secure.example",
      screenshot_refs: [],
      regions: ["main_content"],
      region_partitions: [],
      heat_zones: [],
      request_count: 0,
      param_hotspots: [],
      state_slices: [],
      evidence_refs: [],
    }],
    url_history: [pageUrl],
    confidence: 0.9,
  });
  await store.saveArtifact(runId, "business_catalog", {
    generated_at: "2026-05-22T00:00:00.000Z",
    artifact_type: "business_catalog",
    system_key: systemKey,
    modules: modules || [],
  });
  await store.saveArtifact(runId, "element_map", {
    generated_at: "2026-05-22T00:00:00.000Z",
    artifact_type: "element_map",
    system_key: systemKey,
    elements: [{ element_id: elementId, page_id: pageId, label, selector: "button", action_types: ["click"], region: "main_content", confidence: 0.9, bbox: {}, locator_candidates: [] }],
  });
  await store.saveArtifact(runId, "request_catalog", {
    generated_at: "2026-05-22T00:00:00.000Z",
    artifact_type: "request_catalog",
    system_key: systemKey,
    requests: [],
  });
  await store.saveArtifact(runId, "action_trace", {
    generated_at: "2026-05-22T00:00:00.000Z",
    artifact_type: "action_trace",
    system_key: systemKey,
    actions: [],
  });
  await store.saveArtifact(runId, "semantic_annotations", {
    generated_at: "2026-05-22T00:00:00.000Z",
    artifact_type: "semantic_annotations",
    system_key: systemKey,
    annotations: [],
  });
  await store.saveArtifact(runId, "action_rules", {
    generated_at: "2026-05-22T00:00:00.000Z",
    artifact_type: "action_rules",
    system_key: systemKey,
    actions: [],
    rules: actionRules || [],
  });
  await store.saveArtifact(runId, "recipe_pack", {
    schema_version: "v1",
    artifact_type: "recipe_pack",
    system_key: systemKey,
    recipe_id: "captured_flow",
    title: `Captured ${label}`,
    steps: [],
    playwright_recipe: { steps: [] },
  });
}
