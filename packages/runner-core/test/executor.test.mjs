import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocator, runPack } from "../dist/index.js";

class FakeLocator {
  constructor(page, kind, query) {
    this.page = page;
    this.kind = kind;
    this.query = query;
  }

  async fill(value) {
    this.page.calls.push(["fill", this.kind, this.query, value]);
  }

  async click() {
    this.page.calls.push(["click", this.kind, this.query]);
  }

  async press(key) {
    this.page.calls.push(["press", this.kind, this.query, key]);
  }
}

class FakePage {
  constructor() {
    this.calls = [];
    this.currentUrl = "about:blank";
  }

  locator(selector) {
    return new FakeLocator(this, "css", selector);
  }

  getByRole(role, options) {
    return new FakeLocator(this, "role", `${role}:${options?.name || ""}`);
  }

  getByLabel(text) {
    return new FakeLocator(this, "label", text);
  }

  getByText(text) {
    return new FakeLocator(this, "text", text);
  }

  async goto(url) {
    this.currentUrl = url;
    this.calls.push(["goto", url]);
  }

  async waitForURL(value) {
    this.calls.push(["waitForURL", value]);
    this.currentUrl = typeof value === "string" ? value : this.currentUrl;
  }

  url() {
    return this.currentUrl;
  }
}

test("resolves locators in css, role, label, text order", async () => {
  const page = new FakePage();
  const locator = await resolveLocator(page, [
    { strategy: "text", text: "Search" },
    { strategy: "css", selector: "button[type=submit]" },
  ]);

  await locator.click();

  assert.deepEqual(page.calls, [["click", "css", "button[type=submit]"]]);
});

test("runPack executes browser steps with parameter substitution", async () => {
  const page = new FakePage();
  const result = await runPack({
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
      {
        action: "submit_form",
        target: "search_box",
        locators: [{ strategy: "css", selector: "form" }],
      },
      {
        action: "key_press",
        target: "search_box",
        key: "Enter",
        locators: [{ strategy: "css", selector: "input[name=q]" }],
      },
      {
        action: "wait_for_url",
        target: "results",
        value: "**/search**",
      },
    ],
  }, {
    page,
    params: { query: "上海天气" },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(page.calls, [
    ["goto", "https://cn.bing.com/"],
    ["fill", "css", "input[name=q]", "上海天气"],
    ["click", "css", "form"],
    ["press", "css", "input[name=q]", "Enter"],
    ["waitForURL", "**/search**"],
  ]);
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "passed", "passed", "passed"]);
});

test("runPack reports failed steps without throwing by default", async () => {
  const result = await runPack({
    schema_version: "runner_pack_v1",
    intent: "broken",
    steps: [{ action: "click_text", target: "missing", locators: [] }],
  }, {
    page: new FakePage(),
  });

  assert.equal(result.status, "failed");
  assert.match(result.steps[0].error, /No supported locator/);
});
