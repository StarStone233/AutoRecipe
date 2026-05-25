import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeStore } from "@autorecipe/knowledge-core";
import { CaptureSessionManager } from "../dist/index.js";

test("finalizes capture into mining run and system assets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-capture-"));
  try {
    const store = new KnowledgeStore(dir);
    const manager = new CaptureSessionManager(store);
    const session = await manager.start({
      targetUrl: "https://capture.example/home",
      tabId: 7,
      collectorId: "desktop",
      authStatus: "not_required",
    });

    await manager.ingest(session.sessionId, {
      event_type: "page_loaded",
      url: "https://capture.example/home",
      ts: "2026-05-16T00:00:00.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "layout_snapshot",
      url: "https://capture.example/home",
      ts: "2026-05-16T00:00:00.500Z",
      payload: {
        tab_id: 7,
        page_url: "https://capture.example/home",
        regions: [
          {
            region: "filter_panel",
            x_pct: 10,
            y_pct: 20,
            width_pct: 38,
            height_pct: 18,
            confidence: 0.78,
            source: "test_layout",
            selector_hint: ".filter",
            recognized_by: ["dom_selector"],
          },
        ],
      },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/home",
      ts: "2026-05-16T00:00:01.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home", label: "客户管理", x: 120, y: 80, width: 80, height: 32, x_pct: 24, y_pct: 29, region: "left_nav" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/home",
      ts: "2026-05-16T00:00:01.400Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home", label: "客户管理", x: 123, y: 82, width: 80, height: 32, x_pct: 24.5, y_pct: 29.4, region: "left_nav" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/home",
      ts: "2026-05-16T00:00:01.800Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home", label: "查询", x: 126, y: 85, width: 80, height: 32, x_pct: 25, y_pct: 30, region: "filter_panel" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "network_completed",
      url: "https://capture.example/api/search?q=demo",
      ts: "2026-05-16T00:00:02.000Z",
      payload: {
        tab_id: 7,
        bound_tab_id: 7,
        page_url: "https://capture.example/home",
        url: "https://capture.example/api/search?q=demo",
        method: "GET",
        status_code: 200,
        resource_type: "fetch",
      },
    });

    const result = await manager.stop(session.sessionId);
    const summary = JSON.parse(await readFile(result.artifacts.summary, "utf8"));
    const system = JSON.parse(await readFile(path.join(result.system_dir, "system.json"), "utf8"));
    const pack = JSON.parse(await readFile(path.join(result.system_dir, "actions", "recipe_packs", "captured_flow.json"), "utf8"));
    const pageMap = JSON.parse(await readFile(result.artifacts.page_map, "utf8"));
    const businessCatalog = JSON.parse(await readFile(result.artifacts.business_catalog, "utf8"));
    const systemPageMap = JSON.parse(await readFile(path.join(result.system_dir, "knowledge", "page_map.json"), "utf8"));
    const systemBusinessCatalog = JSON.parse(await readFile(path.join(result.system_dir, "knowledge", "business_catalog.json"), "utf8"));
    const elementMap = JSON.parse(await readFile(result.artifacts.element_map, "utf8"));
    const actionRules = JSON.parse(await readFile(result.artifacts.action_rules, "utf8"));

    assert.equal(result.status, "merged");
    assert.equal(result.mining_root, path.join(dir, "mining"));
    assert.equal(result.run_dir, path.join(dir, "mining", "runs", session.runId));
    assert.equal(summary.counts.interactives, 2);
    assert.equal(summary.counts.heat_zones, 1);
    assert.equal(summary.counts.business_requests, 1);
    assert.equal(system.latest_run_id, session.runId);
    assert.equal(pack.recipe_id, "captured_flow");
    assert.equal(pageMap.pages[0].region_partitions[0].region, "filter_panel");
    assert.equal(pageMap.pages[0].heat_zones[0].event_count, 3);
    assert.equal(pageMap.pages[0].heat_zones[0].region, "filter_panel");
    assert.deepEqual(pageMap.pages[0].heat_zones[0].top_labels, ["客户管理", "查询"]);
    assert.equal(systemPageMap.pages[0].heat_zones[0].event_count, 3);
    assert.equal(businessCatalog.modules[0].title, "客户管理");
    assert.equal(businessCatalog.modules[0].source_region, "left_nav");
    assert.deepEqual(businessCatalog.modules[0].actions.map((item) => item.label), ["客户管理"]);
    assert.equal(systemBusinessCatalog.modules[0].title, "客户管理");
    assert.equal(elementMap.elements[0].element_id.includes("capture_example"), true);
    assert.equal(actionRules.actions.some((action) => action.canonical_action === "客户管理"), true);
    assert.deepEqual(Object.keys(result.artifacts).sort(), [
      "action_rules",
      "action_trace",
      "business_catalog",
      "element_map",
      "evidence_index",
      "manifest",
      "page_map",
      "recipe_pack",
      "request_catalog",
      "semantic_annotations",
      "summary",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quarantines capture with unknown auth status even when artifacts are mergeable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-capture-auth-unknown-"));
  try {
    const store = new KnowledgeStore(dir);
    const manager = new CaptureSessionManager(store);
    const session = await manager.start({
      targetUrl: "https://capture.example/home",
      tabId: 7,
      collectorId: "desktop",
    });

    await manager.ingest(session.sessionId, {
      event_type: "page_loaded",
      url: "https://capture.example/home",
      ts: "2026-05-22T00:00:01.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/home",
      ts: "2026-05-22T00:00:02.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home", label: "查询", x: 10, y: 20 },
    });
    await manager.ingest(session.sessionId, {
      event_type: "network_completed",
      url: "https://capture.example/api/search?q=demo",
      ts: "2026-05-22T00:00:03.000Z",
      payload: {
        tab_id: 7,
        bound_tab_id: 7,
        page_url: "https://capture.example/home",
        url: "https://capture.example/api/search?q=demo",
        method: "GET",
        status_code: 200,
        resource_type: "fetch",
      },
    });

    const result = await manager.stop(session.sessionId);
    const manifest = JSON.parse(await readFile(result.artifacts.manifest, "utf8"));

    assert.equal(result.status, "merged");
    assert.ok(result.system_dir);
    assert.ok(result.merged.runCount >= 1);
    assert.equal(manifest.auth.status, "unknown");
    const system = JSON.parse(await readFile(path.join(store.systemDir(session.systemKey), "system.json"), "utf8"));
    assert.equal(system.run_count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prioritizes navigation actions as page enter and exit paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-navigation-"));
  try {
    const store = new KnowledgeStore(dir);
    const manager = new CaptureSessionManager(store);
    const session = await manager.start({
      targetUrl: "https://capture.example/home",
      tabId: 8,
      collectorId: "desktop",
      authStatus: "not_required",
    });

    await manager.ingest(session.sessionId, {
      event_type: "page_loaded",
      url: "https://capture.example/home",
      ts: "2026-05-16T01:00:00.000Z",
      payload: { tab_id: 8, page_url: "https://capture.example/home" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/home",
      ts: "2026-05-16T01:00:01.000Z",
      payload: { tab_id: 8, page_url: "https://capture.example/home", label: "客户管理", region: "left_nav", x_pct: 8, y_pct: 30 },
    });
    await manager.ingest(session.sessionId, {
      event_type: "url_change",
      url: "https://capture.example/customers",
      ts: "2026-05-16T01:00:02.000Z",
      payload: { tab_id: 8, page_url: "https://capture.example/customers" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "network_completed",
      url: "https://capture.example/api/customers",
      ts: "2026-05-16T01:00:02.500Z",
      payload: {
        tab_id: 8,
        bound_tab_id: 8,
        page_url: "https://capture.example/customers",
        url: "https://capture.example/api/customers",
        method: "GET",
        status_code: 200,
        resource_type: "fetch",
      },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/customers",
      ts: "2026-05-16T01:00:03.000Z",
      payload: { tab_id: 8, page_url: "https://capture.example/customers", label: "返回首页", region: "top_bar", x_pct: 90, y_pct: 5 },
    });
    await manager.ingest(session.sessionId, {
      event_type: "url_change",
      url: "https://capture.example/home",
      ts: "2026-05-16T01:00:04.000Z",
      payload: { tab_id: 8, page_url: "https://capture.example/home" },
    });

    const result = await manager.stop(session.sessionId);
    const pageMap = JSON.parse(await readFile(result.artifacts.page_map, "utf8"));
    const businessCatalog = JSON.parse(await readFile(result.artifacts.business_catalog, "utf8"));
    const systemBusinessCatalog = JSON.parse(await readFile(path.join(result.system_dir, "knowledge", "business_catalog.json"), "utf8"));
    const customersPage = "capture_example_customers";
    const homePage = "capture_example_home";

    assert.equal(result.status, "merged");
    assert.deepEqual(pageMap.navigation_edges.map((edge) => edge.direction), ["enter", "exit"]);
    assert.equal(pageMap.navigation_edges[0].from_page_id, homePage);
    assert.equal(pageMap.navigation_edges[0].to_page_id, customersPage);
    assert.equal(pageMap.navigation_edges[1].from_page_id, customersPage);
    assert.equal(pageMap.navigation_edges[1].to_page_id, homePage);
    assert.equal(businessCatalog.modules[0].title, "客户管理");
    assert.equal(businessCatalog.modules[0].entry_actions[0].to_page_id, customersPage);
    assert.equal(businessCatalog.modules[0].exit_actions[0].to_page_id, homePage);
    assert.equal(systemBusinessCatalog.modules[0].entry_actions[0].to_page_id, customersPage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes auth metadata into run manifest when capture starts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-capture-auth-"));
  try {
    const store = new KnowledgeStore(dir);
    const manager = new CaptureSessionManager(store);
    const session = await manager.start({
      targetUrl: "https://capture.example/home",
      tabId: 7,
      collectorId: "desktop",
      authProfile: "default",
      authStatus: "ready",
      authVerifiedAt: "2026-05-22T00:00:00.000Z",
    });

    const manifest = JSON.parse(await readFile(store.runManifestPath(session.runId), "utf8"));

    assert.equal(session.run.auth_status, "ready");
    assert.equal(session.run.auth_verified_at, "2026-05-22T00:00:00.000Z");
    assert.equal(manifest.auth.status, "ready");
    assert.equal(manifest.auth.verified_at, "2026-05-22T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not merge capture when auth expires during recording", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-capture-auth-expired-"));
  try {
    const store = new KnowledgeStore(dir);
    const manager = new CaptureSessionManager(store);
    const session = await manager.start({
      targetUrl: "https://capture.example/home",
      tabId: 7,
      collectorId: "desktop",
      authProfile: "default",
      authStatus: "ready",
      authVerifiedAt: "2026-05-22T00:00:00.000Z",
    });

    await manager.ingest(session.sessionId, {
      event_type: "page_loaded",
      url: "https://capture.example/home",
      ts: "2026-05-22T00:00:01.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/home",
      ts: "2026-05-22T00:00:02.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home", label: "查询", x: 10, y: 20 },
    });
    await manager.ingest(session.sessionId, {
      event_type: "network_completed",
      url: "https://capture.example/api/search?q=demo",
      ts: "2026-05-22T00:00:03.000Z",
      payload: {
        tab_id: 7,
        bound_tab_id: 7,
        page_url: "https://capture.example/home",
        url: "https://capture.example/api/search?q=demo",
        method: "GET",
        status_code: 200,
        resource_type: "fetch",
      },
    });
    await manager.ingest(session.sessionId, {
      event_type: "auth_state_changed",
      url: "https://capture.example/login",
      ts: "2026-05-22T00:00:04.000Z",
      payload: {
        tab_id: 7,
        page_url: "https://capture.example/login",
        auth_status: "expired",
        reason: "session_expired_banner",
      },
    });

    const result = await manager.stop(session.sessionId);
    const manifest = JSON.parse(await readFile(result.artifacts.manifest, "utf8"));

    assert.equal(result.status, "interrupted_auth_expired");
    assert.equal(result.system_dir, "");
    assert.deepEqual(result.merged, {});
    await assert.rejects(readFile(path.join(store.systemDir(session.systemKey), "system.json"), "utf8"));
    assert.equal(manifest.status, "interrupted_auth_expired");
    assert.equal(manifest.auth.status, "expired");
    assert.equal(manifest.auth.reason, "session_expired_banner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not merge capture when initial auth status is expired", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-capture-auth-initial-expired-"));
  try {
    const store = new KnowledgeStore(dir);
    const manager = new CaptureSessionManager(store);
    const session = await manager.start({
      targetUrl: "https://capture.example/home",
      tabId: 7,
      collectorId: "desktop",
      authProfile: "default",
      authStatus: "expired",
      authVerifiedAt: "2026-05-22T00:00:00.000Z",
    });

    await manager.ingest(session.sessionId, {
      event_type: "page_loaded",
      url: "https://capture.example/home",
      ts: "2026-05-22T00:00:01.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_click",
      url: "https://capture.example/home",
      ts: "2026-05-22T00:00:02.000Z",
      payload: { tab_id: 7, page_url: "https://capture.example/home", label: "查询", x: 10, y: 20 },
    });
    await manager.ingest(session.sessionId, {
      event_type: "network_completed",
      url: "https://capture.example/api/search?q=demo",
      ts: "2026-05-22T00:00:03.000Z",
      payload: {
        tab_id: 7,
        bound_tab_id: 7,
        page_url: "https://capture.example/home",
        url: "https://capture.example/api/search?q=demo",
        method: "GET",
        status_code: 200,
        resource_type: "fetch",
      },
    });

    const result = await manager.stop(session.sessionId);
    const manifest = JSON.parse(await readFile(result.artifacts.manifest, "utf8"));

    assert.equal(result.status, "interrupted_auth_expired");
    assert.equal(result.system_dir, "");
    assert.deepEqual(result.merged, {});
    await assert.rejects(readFile(path.join(store.systemDir(session.systemKey), "system.json"), "utf8"));
    assert.equal(manifest.status, "interrupted_auth_expired");
    assert.equal(manifest.auth.status, "expired");
    assert.equal(manifest.auth.reason, "auth_expired_at_capture_start");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ingests pointer, keydown, and select events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-capture-"));
  try {
    const store = new KnowledgeStore(dir);
    const manager = new CaptureSessionManager(store);
    const session = await manager.start({
      targetUrl: "https://example.com/app",
      tabId: 1,
      collectorId: "desktop",
      authStatus: "not_required",
    });

    await manager.ingest(session.sessionId, {
      event_type: "ui_pointer_start",
      url: "https://example.com/app",
      ts: "2026-05-23T00:00:00.000Z",
      payload: { tab_id: 1, page_url: "https://example.com/app", label: "drag-item", x_pct: 50, y_pct: 50, pointer_type: "mouse" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_pointer_end",
      url: "https://example.com/app",
      ts: "2026-05-23T00:00:00.100Z",
      payload: { tab_id: 1, page_url: "https://example.com/app", label: "drag-item", x_pct: 70, y_pct: 30, pointer_type: "mouse" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_keydown",
      url: "https://example.com/app",
      ts: "2026-05-23T00:00:01.000Z",
      payload: { tab_id: 1, page_url: "https://example.com/app", label: "search-input", key: "Enter" },
    });
    await manager.ingest(session.sessionId, {
      event_type: "ui_select",
      url: "https://example.com/app",
      ts: "2026-05-23T00:00:02.000Z",
      payload: { tab_id: 1, page_url: "https://example.com/app", label: "status-filter", value: "active" },
    });
    // Add a business request with interaction_ref
    await manager.ingest(session.sessionId, {
      event_type: "network_completed",
      url: "https://example.com/api/search",
      ts: "2026-05-23T00:00:01.500Z",
      payload: {
        tab_id: 1,
        page_url: "https://example.com/app",
        url: "https://example.com/api/search",
        method: "POST",
        status_code: 200,
        resource_type: "xhr",
        latency_ms: 120,
        interaction_ref: { element_id: "search-input", type: "key", label: "search-input", ts: 1747958401000 },
      },
    });

    const result = await manager.stop(session.sessionId);
    assert.ok(result.status === "merged" || result.status === "quarantine");
    assert.ok(Object.keys(result.artifacts).length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
