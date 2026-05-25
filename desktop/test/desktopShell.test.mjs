import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const html = readFileSync(join(import.meta.dirname, "../src/index.html"), "utf8");
const main = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
const appPreload = readFileSync(join(import.meta.dirname, "../src/appPreload.ts"), "utf8");
const capturePreload = readFileSync(join(import.meta.dirname, "../src/capturePreload.ts"), "utf8");
const runtime = readFileSync(join(import.meta.dirname, "../../packages/browser-runtime/src/runtime.ts"), "utf8");

test("desktop shell is a standalone AutoRecipe app", () => {
  assert.match(html, /<title>AutoRecipe<\/title>/);
  assert.match(html, /id="openBtn"/);
  assert.match(html, /id="startBtn"/);
  assert.match(html, /id="stopBtn"/);
  assert.doesNotMatch(html, /Corevo|clientSecret|personal-clients|sandbox\.exec|Docker/);
});

test("desktop uses split app and capture preload scripts", () => {
  assert.match(main, /appPreloadPath: path\.join\(__dirname, "appPreload\.js"\)/);
  assert.match(main, /capturePreloadPath: path\.join\(__dirname, "capturePreload\.js"\)/);
  assert.match(runtime, /appPreloadPath: string/);
  assert.match(runtime, /capturePreloadPath: string/);
  assert.match(appPreload, /contextBridge\.exposeInMainWorld\("autorecipe"/);
  assert.doesNotMatch(capturePreload, /contextBridge\.exposeInMainWorld/);
});

test("desktop is not a SaaS connector or shell executor", () => {
  for (const source of [main, appPreload, capturePreload]) {
    assert.doesNotMatch(source, /COREVO_|Corevo|corevo|personal-clients|client_secret|X-Corevo|sandbox\.exec|docker|local-shell/);
  }
});
