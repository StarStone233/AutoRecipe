import assert from "node:assert/strict";
import test from "node:test";
import { normalizePack, renderTemplate, RunnerPackSchema } from "../dist/index.js";

test("validates a normalized runner pack", () => {
  const pack = RunnerPackSchema.parse({
    schema_version: "runner_pack_v1",
    intent: "bing.search",
    entry_url: "https://cn.bing.com/",
    params: {
      query: { type: "string", required: true },
    },
    steps: [
      {
        action: "fill_text",
        target: "search_box",
        value: "{{query}}",
        locators: [{ strategy: "css", selector: "input[name=q]" }],
      },
    ],
    success: [{ type: "url_contains", value: "/search" }],
  });

  assert.equal(pack.intent, "bing.search");
  assert.equal(pack.steps[0].value, "{{query}}");
});

test("normalizes AutoRecipe recipe packs into runner packs", () => {
  const pack = normalizePack({
    schema_version: "v1",
    artifact_type: "recipe_pack",
    system_key: "cn_bing_com",
    recipe_id: "captured_flow",
    title: "Captured desktop flow",
    entry_pages: ["cn_bing_com"],
    steps: [
      {
        action: "fill_text",
        page: "cn_bing_com",
        element_id: "search_box",
        region: "filter_panel",
        text: "无锡明天的天气怎么样",
        semantic_action: "无锡明天的天气怎么样",
        locator_candidates: [
          { strategy: "role", role: "textbox", name: "无锡明天的天气怎么样" },
          { strategy: "css", selector: "input[name=q]" },
        ],
      },
      {
        action: "submit_form",
        page: "cn_bing_com",
        element_id: "search_box",
        region: "filter_panel",
        text: "form",
        semantic_action: "form",
        locator_candidates: [{ strategy: "css", selector: "form" }],
      },
    ],
    matched_requests: [
      {
        host: "static.example.com",
        path_template: "/asset.js",
        method: "GET",
        is_effective: false,
      },
      {
        host: "cn.bing.com",
        path_template: "/search",
        method: "GET",
      },
    ],
  });

  assert.equal(pack.schema_version, "runner_pack_v1");
  assert.equal(pack.intent, "cn_bing_com.captured_flow");
  assert.equal(pack.params.query.type, "string");
  assert.equal(pack.steps[0].value, "{{query}}");
  assert.equal(pack.steps[0].locators[0].strategy, "css");
  assert.equal(pack.steps[1].action, "submit_form");
  assert.deepEqual(pack.success, [{ type: "request_seen", host: "cn.bing.com", path: "/search", method: "GET" }]);
});

test("renders templates with required parameters", () => {
  assert.equal(renderTemplate("搜索 {{query}}", { query: "上海天气" }), "搜索 上海天气");
  assert.throws(
    () => renderTemplate("搜索 {{query}}", {}),
    /Missing template param: query/,
  );
});
