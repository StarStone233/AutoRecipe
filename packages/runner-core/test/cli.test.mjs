import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCliArgs, readPackFile, renderCompactResult } from "../dist/cli.js";

test("parseCliArgs parses run command and params", () => {
  const parsed = parseCliArgs(["run", "pack.json", "--param", "query=上海天气", "--headed", "--engine", "electron"]);

  assert.deepEqual(parsed, {
    command: "run",
    packPath: "pack.json",
    params: { query: "上海天气" },
    headed: true,
    engine: "electron",
    browser: "chromium",
    compact: false,
  });
});

test("readPackFile reads json packs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "runner-cli-"));
  try {
    const file = path.join(dir, "pack.json");
    await writeFile(file, JSON.stringify({ schema_version: "runner_pack_v1", intent: "demo" }), "utf8");

    const pack = await readPackFile(file);

    assert.equal(pack.intent, "demo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderCompactResult prints the status and final url", () => {
  const text = renderCompactResult({
    status: "passed",
    intent: "bing.search",
    steps: [{ index: 0, action: "fill_text", target: "search_box", status: "passed" }],
    assertions: [{ index: 0, type: "url_contains", status: "passed" }],
    requests: [],
  }, "https://cn.bing.com/search?q=test");

  assert.match(text, /status: passed/);
  assert.match(text, /finalUrl: https:\/\/cn\.bing\.com\/search\?q=test/);
  assert.match(text, /0 fill_text search_box passed/);
});
