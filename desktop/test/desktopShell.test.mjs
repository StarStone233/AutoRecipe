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
  assert.match(html, /id="learnedPanel"/);
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

test("desktop exposes a learned artifact display layer", () => {
  const renderer = readFileSync(join(import.meta.dirname, "../src/renderer.ts"), "utf8");
  assert.match(main, /ipcMain\.handle\("autorecipe:learned:get"/);
  assert.match(main, /async function getLearnedArtifacts/);
  assert.match(main, /async function learnedPreview/);
  assert.match(main, /pathToFileURL/);
  assert.match(appPreload, /getLearned:\s*\(payload\?: \{ runId\?: string \}\)/);
  assert.match(renderer, /const learnedPanel = document\.querySelector<HTMLElement>\("#learnedPanel"\)!/);
  assert.match(renderer, /function renderLearned/);
  assert.match(renderer, /function renderPreview/);
  assert.match(renderer, /function appendOverlay/);
  assert.match(main, /viewportBbox/);
  assert.match(main, /records\(pageMap\.surfaces\)/);
  assert.match(html, /\.previewStage/);
  assert.match(html, /\.overlayBox/);
  assert.match(renderer, /appendLearnedGroup\("Surfaces"/);
  assert.match(renderer, /appendLearnedGroup\("Pages"/);
  assert.match(renderer, /appendLearnedGroup\("Modules"/);
  assert.match(renderer, /appendLearnedGroup\("Requests"/);
  assert.match(renderer, /appendLearnedGroup\("Rules"/);
  assert.match(renderer, /appendLearnedGroup\("Recipe"/);
});

test("desktop is not a SaaS connector or shell executor", () => {
  for (const source of [main, appPreload, capturePreload]) {
    assert.doesNotMatch(source, /COREVO_|Corevo|corevo|personal-clients|client_secret|X-Corevo|sandbox\.exec|docker|local-shell/);
  }
});
