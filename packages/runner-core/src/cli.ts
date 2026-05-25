#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePack } from "./schema.js";
import { runPack, type RunnerTrace } from "./executor.js";
import type { PageLike } from "./pageTypes.js";
import type { RunnerParams } from "./schema.js";

export type CliOptions = {
  command: "run";
  packPath: string;
  params: RunnerParams;
  headed: boolean;
  engine: "playwright" | "electron";
  browser: "chromium" | "firefox" | "webkit";
  compact: boolean;
};

export function parseCliArgs(args: string[]): CliOptions {
  const [command, packPath, ...rest] = args;
  if (command !== "run" || !packPath) throw new Error("Usage: recipe-runner run <pack.json> [--param key=value] [--engine electron] [--headed] [--compact]");

  const params: RunnerParams = {};
  let headed = false;
  let engine: CliOptions["engine"] = "playwright";
  let browser: CliOptions["browser"] = "chromium";
  let compact = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--headed") {
      headed = true;
    } else if (arg === "--compact") {
      compact = true;
    } else if (arg === "--engine") {
      const next = rest[index + 1] || "";
      index += 1;
      if (next !== "playwright" && next !== "electron") throw new Error(`Unsupported engine: ${next}`);
      engine = next;
    } else if (arg === "--param") {
      const next = rest[index + 1] || "";
      index += 1;
      const eq = next.indexOf("=");
      if (eq <= 0) throw new Error(`Invalid --param value: ${next}`);
      params[next.slice(0, eq)] = next.slice(eq + 1);
    } else if (arg === "--browser") {
      const next = rest[index + 1] || "";
      index += 1;
      if (next !== "chromium" && next !== "firefox" && next !== "webkit") throw new Error(`Unsupported browser: ${next}`);
      browser = next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, packPath, params, headed, engine, browser, compact };
}

export async function readPackFile(packPath: string): Promise<unknown> {
  return JSON.parse(await readFile(packPath, "utf8"));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const rawPack = await readPackFile(options.packPath);
  const pack = normalizePack(rawPack);
  const launch = options.engine === "electron"
    ? await launchElectronPage(options.headed)
    : await launchPlaywrightPage(options.browser, options.headed);
  try {
    const result = await runPack(pack, { page: launch.page, params: options.params });
    console.log(options.compact ? renderCompactResult(result, launch.page.url?.() || "") : JSON.stringify({ ...result, finalUrl: launch.page.url?.() || "" }, null, 2));
    if (result.status !== "passed") process.exitCode = 1;
  } finally {
    await launch.close();
  }
}

export function renderCompactResult(result: RunnerTrace, finalUrl: string): string {
  const lines = [
    `status: ${result.status}`,
    `intent: ${result.intent}`,
    `finalUrl: ${finalUrl}`,
    "steps:",
    ...result.steps.map((step) => `  ${step.index} ${step.action} ${step.target} ${step.status}${step.error ? ` ${step.error}` : ""}`),
    "assertions:",
    ...result.assertions.map((assertion) => `  ${assertion.index} ${assertion.type} ${assertion.status}${assertion.error ? ` ${assertion.error}` : ""}`),
    `requests: ${result.requests.length}`,
  ];
  return lines.join("\n");
}

async function launchPlaywrightPage(browserName: CliOptions["browser"], headed: boolean): Promise<{ page: PageLike; close: () => Promise<void> }> {
  const playwright = await importPlaywright();
  const browserType = playwright[browserName] as { launch: (options: { headless: boolean }) => Promise<{ newPage: () => Promise<PageLike>; close: () => Promise<void> }> } | undefined;
  if (!browserType) throw new Error(`Playwright browser is unavailable: ${browserName}`);
  const browser = await browserType.launch({ headless: !headed });
  return { page: await browser.newPage(), close: () => browser.close() };
}

async function launchElectronPage(_headed: boolean): Promise<{ page: PageLike; close: () => Promise<void> }> {
  const playwright = await importPlaywright();
  const launcher = playwright._electron as { launch: (options: { args: string[] }) => Promise<{ firstWindow: () => Promise<PageLike>; close: () => Promise<void> }> } | undefined;
  if (!launcher) throw new Error("playwright-core _electron launcher is unavailable.");
  const dir = await mkdtemp(path.join(os.tmpdir(), "autorecipe-runner-"));
  const mainPath = path.join(dir, "main.cjs");
  await writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
`, "utf8");
  const app = await launcher.launch({ args: [mainPath] });
  return {
    page: await app.firstWindow(),
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function importPlaywright(): Promise<Record<string, unknown>> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  try {
    return await dynamicImport("playwright");
  } catch {
    try {
      return await dynamicImport("playwright-core");
    } catch {
      throw new Error("Install playwright or playwright-core to use the recipe-runner CLI.");
    }
  }
}

if (process.argv[1]?.endsWith("/recipe-runner") || process.argv[1]?.endsWith("/cli.js")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
