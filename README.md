# AutoRecipe

AutoRecipe is a local-first browser mining toolkit. It opens a real Electron Chromium session, captures user interactions and network requests, and writes local artifacts that describe a web application's pages, actions, requests, and runnable recipes.

## What It Includes

- Electron desktop app for opening a target site and recording a workflow.
- Capture core for DOM events, page transitions, screenshots, and fetch/XHR requests.
- Knowledge core for generating `page_map`, `business_catalog`, `request_catalog`, `action_rules`, and `recipe_pack` artifacts.
- Browser runtime with a local CDP endpoint that can be attached by `playwright-core`.
- Runner core for executing constrained `runner_pack_v1` recipes.

## Layout

```text
desktop/                  Minimal Electron desktop app
packages/
  browser-runtime/        Electron BrowserView runtime and capture bridge
  capture-core/           Capture session model and network event normalization
  knowledge-core/         Local mining workspace and artifact generation
  runner-core/            Standalone recipe runner for Playwright-compatible pages
examples/                 Local fixtures and sample runner packs
```

## Development

```bash
npm install
npm run build
npm test
npm run desktop:dev
```

The desktop app writes data under Electron `userData` by default. Override the workspace location with:

```bash
AUTORECIPE_WORKSPACE_ROOT=/path/to/workspace npm run desktop:dev
```

The Chromium DevTools Protocol endpoint defaults to `http://127.0.0.1:17375`. Override it with:

```bash
AUTORECIPE_CDP_PORT=17376 npm run desktop:dev
```

Optional semantic enrichment can be enabled with:

```bash
AUTORECIPE_LLM_API_KEY=... AUTORECIPE_LLM_BASE_URL=... AUTORECIPE_LLM_MODEL=... npm run desktop:dev
```

Without an LLM key, AutoRecipe still generates deterministic maps, request catalogs, action rules, and recipe packs.

## Output

Each capture creates a run under:

```text
<workspace>/mining/runs/<run_id>/
  raw/events.jsonl
  raw/screenshots/
  artifacts/page_map.json
  artifacts/business_catalog.json
  artifacts/element_map.json
  artifacts/request_catalog.json
  artifacts/action_trace.json
  artifacts/action_rules.json
  artifacts/recipe_pack.json
  artifacts/summary.json
```

Merged system-level artifacts are written under:

```text
<workspace>/mining/systems/<system_key>/
```

## Playwright CDP

Install `playwright-core` in your own integration and connect to the running desktop browser:

```ts
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:17375");
const page = browser.contexts()[0].pages()[0];
console.log(await page.title());
```

## Safety

AutoRecipe runs locally and writes local files. It does not include a SaaS connector, remote command channel, Docker runtime, or local shell executor. Avoid recording sensitive credentials; auth-related URLs and storage signal names are redacted where the artifact model handles them.
