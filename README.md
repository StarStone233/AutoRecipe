# AutoRecipe

AutoRecipe is a local-first browser workflow miner. It opens a real Electron Chromium browser, records what you do on a website, and turns the session into visual learning artifacts, API request maps, action rules, and runnable recipes.

It is built for quickly understanding how a web product works from direct use, without sending browser activity to a SaaS backend.

## Why It Is Useful

- **See the capture result immediately**: after stopping a run, the desktop app shows learned surfaces with screenshots, overlays, action hot zones, and request counts.
- **Handles popups and secondary UI**: dialogs, menus, drawers, dropdowns, search option panels, and child windows are tracked as page surfaces instead of being flattened into one page.
- **Keeps learning scoped**: starting from `https://cn.bing.com` learns inside `bing.com`; unrelated domains stay as raw evidence and are not shown as learned knowledge.
- **Connects UI actions to network behavior**: fetch/XHR requests are normalized and associated with nearby actions.
- **Generates automation assets**: each capture can produce page maps, request catalogs, action traces, rules, and recipe packs.
- **Runs locally**: no SaaS connector, remote shell channel, Docker executor, or hidden command runner.

## Quick Start

```bash
git clone https://github.com/StarStone233/AutoRecipe.git
cd AutoRecipe
npm install
npm run desktop:dev
```

Then:

1. Enter a target URL.
2. Click **Open**.
3. Click **Start**.
4. Use the website normally.
5. Click **Stop**.
6. Review the learned surfaces, overlays, requests, rules, and recipe steps in the desktop app.

## What You See After Capture

AutoRecipe prioritizes a visual feedback loop:

```text
Learned Surfaces
  page or popup screenshot
  surface bounds
  action overlays
  action count
  in-scope request count

Details
  learned pages
  request catalog
  action rules
  generated recipe steps
```

For example, if a search settings popup opens on Bing, AutoRecipe keeps it as a secondary surface with its own bounds and coordinates. Actions inside the popup are displayed on that popup, not misplaced on the full page.

## Repository Layout

```text
desktop/                  Electron desktop app
packages/
  browser-runtime/        BrowserView runtime, capture bridge, CDP endpoint
  capture-core/           Capture sessions and event ingestion
  knowledge-core/         Local storage, schemas, artifact generation
  runner-core/            Constrained recipe runner
examples/                 Sample runner packs and local fixtures
CONTEXT.md                Project vocabulary and learning model
```

## Commands

```bash
npm install
npm run build
npm run typecheck
npm test
npm run desktop:dev
```

Run the built desktop app:

```bash
npm run desktop:start
```

## Configuration

Use a custom workspace:

```bash
AUTORECIPE_WORKSPACE_ROOT=/path/to/workspace npm run desktop:dev
```

Use a custom CDP port:

```bash
AUTORECIPE_CDP_PORT=17376 npm run desktop:dev
```

Enable optional semantic enrichment:

```bash
AUTORECIPE_LLM_API_KEY=... \
AUTORECIPE_LLM_BASE_URL=... \
AUTORECIPE_LLM_MODEL=... \
npm run desktop:dev
```

Without an LLM key, AutoRecipe still generates deterministic artifacts.

## Generated Files

Each capture creates a run under:

```text
<workspace>/mining/runs/<run_id>/
  raw/events.jsonl
  raw/screenshots/
  artifacts/evidence_index.json
  artifacts/page_map.json
  artifacts/business_catalog.json
  artifacts/element_map.json
  artifacts/request_catalog.json
  artifacts/action_trace.json
  artifacts/action_rules.json
  artifacts/recipe_pack.json
  artifacts/summary.json
```

Merged system-level knowledge is written under:

```text
<workspace>/mining/systems/<system_key>/
```

## Playwright CDP

The desktop browser exposes CDP on `127.0.0.1:17375` by default:

```ts
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:17375");
const page = browser.contexts()[0].pages()[0];
console.log(await page.title());
```

## Runner

`@autorecipe/runner-core` runs constrained `runner_pack_v1` recipes. It supports explicit browser actions such as `fill_text`, `click_text`, `submit_form`, `key_press`, and `wait_for_url`.

Example:

```bash
npm install --save-dev playwright
npm run build
node packages/runner-core/dist/cli.js run examples/bing-search.runner-pack.json --param query=autorecipe --headed --compact
```

See [packages/runner-core/README.md](packages/runner-core/README.md) for the runner format.

## Safety

AutoRecipe writes local files and may capture sensitive browser activity. Use a test account when possible, avoid typing secrets while recording, and review `raw/events.jsonl` before sharing a workspace.

Project boundaries:

- no SaaS connector;
- no remote command channel;
- no Docker runtime;
- no local shell executor;
- external domains are raw evidence only, not learned display content.

## License

MIT. See [LICENSE](LICENSE).
