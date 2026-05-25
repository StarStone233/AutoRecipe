import assert from "node:assert/strict";
import test from "node:test";
import { buildMiningInspector } from "../dist/autorecipeInspector.js";

test("summarizes live mining navigation modules heat zones and actions", () => {
  const summary = buildMiningInspector({
    active: true,
    runId: "run_live",
    events: [
      {
        event_type: "page_loaded",
        url: "https://capture.example/home",
        ts: "2026-05-22T00:00:00.000Z",
        payload: { page_url: "https://capture.example/home" },
      },
      {
        event_type: "ui_click",
        url: "https://capture.example/home",
        ts: "2026-05-22T00:00:01.000Z",
        payload: { page_url: "https://capture.example/home", label: "客户管理", region: "left_nav" },
      },
      {
        event_type: "url_change",
        url: "https://capture.example/customers",
        ts: "2026-05-22T00:00:02.000Z",
        payload: { page_url: "https://capture.example/customers" },
      },
      {
        event_type: "ui_click",
        url: "https://capture.example/customers",
        ts: "2026-05-22T00:00:03.000Z",
        payload: { page_url: "https://capture.example/customers", label: "查询", region: "filter_panel" },
      },
      {
        event_type: "network_completed",
        url: "https://capture.example/api/customers",
        ts: "2026-05-22T00:00:04.000Z",
        payload: { page_url: "https://capture.example/customers", url: "https://capture.example/api/customers" },
      },
      {
        event_type: "ui_click",
        url: "https://capture.example/customers",
        ts: "2026-05-22T00:00:05.000Z",
        payload: { page_url: "https://capture.example/customers", label: "返回首页", region: "top_bar" },
      },
      {
        event_type: "url_change",
        url: "https://capture.example/home",
        ts: "2026-05-22T00:00:06.000Z",
        payload: { page_url: "https://capture.example/home" },
      },
    ],
  });

  assert.equal(summary.active, true);
  assert.equal(summary.runId, "run_live");
  assert.equal(summary.page_id, "capture_example_home");
  assert.deepEqual(summary.navigation_edges.map((edge) => edge.direction), ["enter", "exit"]);
  assert.deepEqual(summary.modules.map((module) => module.title), ["客户管理"]);
  assert.equal(summary.modules[0].exit_count, 1);
  assert.equal(summary.heat_zones.some((zone) => zone.label === "查询" && zone.event_count === 1), true);
  assert.equal(summary.recent_actions[0].label, "返回首页");
  assert.equal(summary.recent_actions.find((action) => action.label === "查询")?.request_count, 1);
});
