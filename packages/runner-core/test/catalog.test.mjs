import assert from "node:assert/strict";
import test from "node:test";
import { getRunnerActionCatalog, validateRunnerPack, withRunnerPackRequires } from "../dist/index.js";

test("exports the finite runner action catalog", () => {
  const catalog = getRunnerActionCatalog();

  assert.equal(catalog.schema_version, "runner_action_catalog_v1");
  assert.equal(catalog.actions.some((item) => item.name === "fill_text"), true);
  assert.deepEqual(catalog.locator_strategies.map((item) => item.name), ["css", "role", "label", "text"]);
  assert.equal(catalog.assertions.some((item) => item.name === "request_seen"), true);
  assert.match(catalog.runner_catalog_hash, /^[a-f0-9]{16}$/);
});

test("validates catalog-bound runner packs and fills requires metadata", () => {
  const result = validateRunnerPack({
    schema_version: "runner_pack_v1",
    intent: "bing.search",
    entry_url: "https://cn.bing.com/",
    params: { query: { type: "string", required: true } },
    steps: [
      {
        action: "fill_text",
        target: "search_box",
        value: "{{query}}",
        locators: [{ strategy: "css", selector: "input[name=q]" }],
      },
      { action: "wait_for_url", value: "**/search**" },
    ],
    success: [{ type: "url_contains", value: "/search" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.pack.requires.runner_core_version, "0.1.0");
  assert.equal(result.pack.requires.runner_catalog_version, "0.1.0");
});

test("rejects generated packs outside the catalog boundary", () => {
  const result = validateRunnerPack({
    schema_version: "runner_pack_v1",
    intent: "unsafe",
    entry_url: "file:///tmp/a.html",
    steps: [
      {
        action: "click_text",
        locators: [{ strategy: "coordinate", x: 1, y: 2 }],
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((item) => item.includes("entry_url")), true);
  assert.equal(result.errors.some((item) => item.includes("coordinate")), true);
});

test("withRunnerPackRequires fills runner version requirements", () => {
  const pack = withRunnerPackRequires({
    schema_version: "runner_pack_v1",
    intent: "minimal",
    entry_url: "https://example.com",
    params: {},
    steps: [],
    success: [],
  });

  assert.deepEqual(pack.requires, {
    runner_core_version: "0.1.0",
    runner_catalog_version: "0.1.0",
  });
});
