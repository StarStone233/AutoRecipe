import assert from "node:assert/strict";
import test from "node:test";
import { runPack } from "../dist/index.js";

class VisibleLocator {
  constructor(visible = true) {
    this.visible = visible;
  }

  async click() {}

  async isVisible() {
    return this.visible;
  }
}

class AssertionPage {
  constructor() {
    this.handlers = new Map();
    this.currentUrl = "https://cn.bing.com/search?q=test";
  }

  locator() {
    return new VisibleLocator();
  }

  getByText(text) {
    return new VisibleLocator(text === "weather result");
  }

  url() {
    return this.currentUrl;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  off(event) {
    this.handlers.delete(event);
  }

  emitRequest(url, method = "GET") {
    this.handlers.get("request")?.({
      url: () => url,
      method: () => method,
    });
  }

  emitPlaywrightStyleRequest(url, method = "GET") {
    this.handlers.get("request")?.({
      value: url,
      httpMethod: method,
      url() {
        return this.value;
      },
      method() {
        return this.httpMethod;
      },
    });
  }
}

test("runPack validates url, text, and request assertions", async () => {
  const page = new AssertionPage();
  const run = runPack({
    schema_version: "runner_pack_v1",
    intent: "bing.search",
    steps: [
      {
        action: "click_text",
        target: "search",
        locators: [{ strategy: "css", selector: "button[type=submit]" }],
      },
    ],
    success: [
      { type: "url_contains", value: "/search" },
      { type: "text_visible", text: "weather result" },
      { type: "request_seen", host: "cn.bing.com", path: "/search", method: "GET" },
    ],
  }, { page });

  page.emitRequest("https://cn.bing.com/search?q=test");
  const result = await run;

  assert.equal(result.status, "passed");
  assert.deepEqual(result.assertions.map((item) => item.status), ["passed", "passed", "passed"]);
});

test("runPack reports assertion failures", async () => {
  const result = await runPack({
    schema_version: "runner_pack_v1",
    intent: "bing.search",
    steps: [],
    success: [{ type: "url_contains", value: "/missing" }],
  }, { page: new AssertionPage() });

  assert.equal(result.status, "failed");
  assert.equal(result.assertions[0].status, "failed");
  assert.match(result.assertions[0].error, /URL does not contain/);
});

test("request recorder preserves Playwright request method binding", async () => {
  const page = new AssertionPage();
  const run = runPack({
    schema_version: "runner_pack_v1",
    intent: "binding",
    steps: [{ action: "click_text", target: "search", locators: [{ strategy: "css", selector: "button" }] }],
    success: [{ type: "request_seen", host: "cn.bing.com", path: "/search", method: "GET" }],
  }, { page });

  page.emitPlaywrightStyleRequest("https://cn.bing.com/search?q=test");
  const result = await run;

  assert.equal(result.status, "passed");
  assert.equal(result.requests[0].url, "https://cn.bing.com/search?q=test");
});
