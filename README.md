# AutoRecipe

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-desktop-47848f.svg)](https://www.electronjs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-compatible-2ead33.svg)](https://playwright.dev/)

AutoRecipe is a local-first browser workflow mining toolkit. It opens a real Electron Chromium session, records user interactions and network activity, and turns a captured workflow into local knowledge artifacts: page maps, surface overlays, request catalogs, action rules, and runnable recipes.

The project is designed for people who want to learn how a web application behaves from direct use without shipping browser activity to a SaaS backend.

## Highlights

- **Local-first capture**: records inside a local Electron browser and writes artifacts to local disk.
- **Surface-first learning**: understands full pages, dialogs, popups, drawers, dropdowns, and child-window surfaces.
- **Bounded learning scope**: learned pages and requests are constrained to the starting site's registrable domain.
- **Visual feedback**: learned surfaces include screenshots, bounds, heat zones, and action overlays.
- **Network-aware mining**: captures fetch/XHR requests and associates them with nearby user actions.
- **Recipe generation**: produces replayable recipe artifacts and a constrained runner format.
- **Playwright-compatible runtime**: exposes a local CDP endpoint for integrations.
- **No remote shell channel**: this repository does not include a SaaS connector, Docker executor, or local shell executor.

## Table of Contents

- [Use Cases](#use-cases)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Desktop Workflow](#desktop-workflow)
- [Configuration](#configuration)
- [Generated Artifacts](#generated-artifacts)
- [Learning Model](#learning-model)
- [Playwright CDP Integration](#playwright-cdp-integration)
- [Recipe Runner](#recipe-runner)
- [Development](#development)
- [Testing](#testing)
- [Privacy and Safety](#privacy-and-safety)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Use Cases

AutoRecipe is useful when you need to:

- inspect how a web app's pages, forms, popups, and APIs behave during a user workflow;
- turn manual browser operations into structured local artifacts;
- discover action-to-request relationships for workflow automation;
- create replayable recipes without hand-writing the first draft;
- keep sensitive internal application exploration on a local machine.

It is not a general-purpose web crawler, a credential collector, a remote browser service, or an arbitrary command execution framework.

## Architecture

```text
Electron Desktop App
  |
  | opens target site, displays browser, controls capture
  v
Browser Runtime
  |
  | injects capture preload, exposes CDP, manages local browser session
  v
Capture Core
  |
  | normalizes DOM events, navigation, screenshots, and network events
  v
Knowledge Core
  |
  | builds page maps, surfaces, request catalogs, action rules, recipes
  v
Runner Core
  |
  | validates and executes constrained runner_pack_v1 recipes
```

The desktop app is the easiest entry point. The packages are kept separate so the capture, mining, and runner layers can be reused independently.

## Repository Layout

```text
.
|-- desktop/                  Electron desktop application
|   |-- src/main.ts           Electron main process and app IPC
|   |-- src/capturePreload.ts Capture-side DOM/event instrumentation
|   |-- src/appPreload.ts     Desktop UI preload bridge
|   `-- src/renderer.ts       Desktop UI rendering
|-- packages/
|   |-- browser-runtime/      Electron BrowserView runtime and CDP setup
|   |-- capture-core/         Capture sessions and event ingestion
|   |-- knowledge-core/       Local workspace, schemas, artifact generation
|   `-- runner-core/          Constrained recipe runner and CLI
|-- examples/                 Sample runner packs and local fixtures
|-- CONTEXT.md                Project language and domain model
|-- package.json              npm workspace root
`-- LICENSE                   MIT license
```

## Requirements

- macOS or Linux for local development. The desktop app is currently developed on macOS.
- Node.js 22 or newer is recommended.
- npm 10 or newer.
- A machine capable of running Electron Chromium.

Optional:

- `playwright` or `playwright-core` if you want to use the recipe runner CLI or connect over CDP from your own integration.
- An OpenAI-compatible LLM endpoint if you want optional semantic enrichment. The deterministic artifact pipeline works without it.

## Quick Start

```bash
git clone https://github.com/StarStone233/AutoRecipe.git
cd AutoRecipe
npm install
npm run build
npm run desktop:dev
```

The desktop app opens with a control sidebar and a browser workspace. Enter a URL, open it, start capture, perform the workflow, and stop capture to generate local artifacts.

## Desktop Workflow

1. Start the app:

   ```bash
   npm run desktop:dev
   ```

2. Enter a target URL, for example:

   ```text
   https://cn.bing.com
   ```

3. Click **Open** to load the site.

4. Click **Start** to begin capture.

5. Use the browser normally. AutoRecipe records visible user actions, page transitions, screenshots, and fetch/XHR requests.

6. Click **Stop**. AutoRecipe finalizes the run and shows learned surfaces, overlays, requests, rules, and recipe steps.

7. Use **Open Run Dir** in the desktop app to inspect generated files.

## Configuration

### Workspace Location

By default, the desktop app writes under Electron's `userData` directory. Override it with:

```bash
AUTORECIPE_WORKSPACE_ROOT=/path/to/autorecipe-workspace npm run desktop:dev
```

### CDP Port

AutoRecipe exposes Chromium DevTools Protocol on `127.0.0.1:17375` by default:

```bash
AUTORECIPE_CDP_PORT=17376 npm run desktop:dev
```

### Optional Semantic Enrichment

The core artifact pipeline does not require an LLM. To enable optional semantic enrichment:

```bash
AUTORECIPE_LLM_API_KEY=... \
AUTORECIPE_LLM_BASE_URL=... \
AUTORECIPE_LLM_MODEL=... \
npm run desktop:dev
```

If no API key is configured, AutoRecipe still generates page maps, surface overlays, request catalogs, action traces, action rules, and recipe packs.

## Generated Artifacts

Each capture creates a run directory:

```text
<workspace>/mining/runs/<run_id>/
|-- manifest.json
|-- raw/
|   |-- events.jsonl
|   `-- screenshots/
`-- artifacts/
    |-- evidence_index.json
    |-- page_map.json
    |-- business_catalog.json
    |-- element_map.json
    |-- request_catalog.json
    |-- action_trace.json
    |-- semantic_annotations.json
    |-- action_rules.json
    |-- recipe_pack.json
    `-- summary.json
```

Merged system-level artifacts are written under:

```text
<workspace>/mining/systems/<system_key>/
|-- system.json
|-- runs_index.json
|-- knowledge/
|   |-- page_map.json
|   |-- business_catalog.json
|   |-- element_map.json
|   |-- request_catalog.json
|   |-- semantic_annotations.json
|   `-- operation_manual.json
`-- actions/
    |-- action_rules.json
    |-- index.json
    `-- recipe_packs/
        `-- captured_flow.json
```

### Artifact Summary

| Artifact | Purpose |
| --- | --- |
| `evidence_index.json` | Raw event and screenshot references. |
| `page_map.json` | Learned pages, page surfaces, heat zones, navigation edges, and request counts. |
| `business_catalog.json` | Inferred business modules and related navigation actions. |
| `element_map.json` | Interactive elements with labels, regions, selectors, and locator candidates. |
| `request_catalog.json` | In-scope network requests grouped by normalized request signatures. |
| `action_trace.json` | Ordered learned user actions with page and surface coordinates. |
| `action_rules.json` | Action rules inferred from observed actions and request effects. |
| `recipe_pack.json` | Generated AutoRecipe recipe steps. |
| `summary.json` | Counts and artifact paths for the finalized run. |

## Learning Model

AutoRecipe uses a bounded, surface-first model.

### Learning Scope

The Learning Scope is the registrable domain of the starting URL.

Example:

```text
Starting URL:   https://cn.bing.com
Learning Scope: bing.com
In scope:       cn.bing.com, www.bing.com, api.bing.com
Out of scope:   login.live.com, example.com
```

External activity is kept as underlying evidence, but it does not become learned pages or learned requests.

### Page Surfaces

A Page Surface is a visible area where user actions happen:

- **Primary Page**: the main browser navigation URL.
- **Secondary Surface**: a dialog, menu, popup, drawer, dropdown, or similar surface attached to the current page.
- **Child Window Surface**: a separate popup/window that is still inside the Learning Scope.

AutoRecipe stores both viewport-relative bounds and surface-relative bounds. The learned overlay view uses surface-relative coordinates so actions inside a popup are shown on that popup rather than smeared across the full page.

See [CONTEXT.md](CONTEXT.md) for the project vocabulary and modeling decisions.

## Playwright CDP Integration

While the desktop app is running, connect to its local Chromium instance:

```ts
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:17375");
const context = browser.contexts()[0];
const page = context.pages()[0];

console.log(await page.title());
```

This is useful for external inspection and controlled automation experiments. AutoRecipe itself still owns the capture lifecycle in the desktop app.

## Recipe Runner

`@autorecipe/runner-core` validates and executes constrained `runner_pack_v1` recipes. It intentionally supports a small action catalog instead of arbitrary JavaScript or shell execution.

Supported actions:

- `fill_text`
- `click_text`
- `submit_form`
- `key_press`
- `wait_for_url`

Supported locator strategies:

- `css`
- `role`
- `label`
- `text`

Run the example pack after installing Playwright:

```bash
npm install --save-dev playwright
npm run build
node packages/runner-core/dist/cli.js run examples/bing-search.runner-pack.json --param query=autorecipe --headed --compact
```

For the runner API and pack examples, see [packages/runner-core/README.md](packages/runner-core/README.md).

## Development

Install dependencies:

```bash
npm install
```

Build all workspaces:

```bash
npm run build
```

Start the desktop app in development mode:

```bash
npm run desktop:dev
```

Start the already-built desktop app:

```bash
npm run desktop:start
```

Run type checks:

```bash
npm run typecheck
```

## Testing

Run the full test suite:

```bash
npm test
```

Run package-specific tests:

```bash
npm --workspace @autorecipe/knowledge-core run test
npm --workspace @autorecipe/capture-core run test
npm --workspace @autorecipe/browser-runtime run test
npm --workspace @autorecipe/runner-core run test
npm --workspace @autorecipe/desktop run test
```

The tests cover schema validation, workspace persistence, auth signal redaction, capture finalization, surface grouping, request scoping, runtime view policy, runner pack validation, and desktop shell behavior.

## Privacy and Safety

AutoRecipe is local-first, but browser capture can still include sensitive data. Treat generated artifacts as sensitive unless you have reviewed them.

Important boundaries:

- No SaaS connector is included.
- No remote command channel is included.
- No local shell executor is included.
- No Docker runtime is included.
- External domains are retained as raw evidence only and are not displayed as learned knowledge.
- Auth-related URLs and storage signals are redacted where the artifact model handles them.

Recommended practice:

- Use a dedicated test account when recording workflows.
- Avoid typing passwords or secrets while capture is active.
- Review `raw/events.jsonl` and generated artifacts before sharing them.
- Keep `AUTORECIPE_WORKSPACE_ROOT` outside synced folders if captures may contain private data.

## Troubleshooting

### Electron does not open

Run a clean build:

```bash
npm run build
npm run desktop:dev
```

If dependencies are stale:

```bash
rm -rf node_modules package-lock.json
npm install
npm run desktop:dev
```

### The browser area is hidden

Use the **Browser** toggle in the desktop toolbar. The app can hide the browser workspace while still showing capture status and learned artifacts.

### Port `17375` is already in use

Set another CDP port:

```bash
AUTORECIPE_CDP_PORT=17376 npm run desktop:dev
```

### No learned artifacts appear

Confirm that:

- capture was started before performing the workflow;
- the workflow happened inside the Learning Scope of the starting URL;
- the run was stopped successfully;
- the workspace path is the one you expect.

### Requests from another domain are missing

This is expected. AutoRecipe only promotes in-scope requests into learned request catalogs. Cross-domain activity remains raw evidence.

### Runner CLI cannot find Playwright

Install `playwright` or `playwright-core` in your project:

```bash
npm install --save-dev playwright
```

## Roadmap

- Richer surface detection for iframes and child windows.
- Cropped surface screenshots for cleaner popup and dialog previews.
- More robust public suffix handling for Learning Scope.
- Better recipe normalization from mined actions.
- Optional export formats for third-party automation tools.
- Packaged desktop releases.

## Contributing

Contributions are welcome. Please keep changes aligned with the local-first security model.

Before opening a pull request:

```bash
npm run typecheck
npm test
```

Guidelines:

- Keep capture and runner behavior deterministic when possible.
- Do not add remote execution, shell execution, or credential collection paths.
- Add tests for schema changes, artifact changes, and user-visible desktop behavior.
- Update [CONTEXT.md](CONTEXT.md) when changing core terminology or the learning model.

## License

AutoRecipe is released under the [MIT License](LICENSE).
