# AutoRecipe Runner Core

`@autorecipe/runner-core` runs constrained `runner_pack_v1` browser recipes. It is the authority for the Runner Action Catalog; SaaS, Chat, desktop, and future callers should consume this package rather than defining their own action lists.

## Catalog API

```ts
import {
  getRunnerActionCatalog,
  validateRunnerPack,
  withRunnerPackRequires,
} from "@autorecipe/runner-core";

const catalog = getRunnerActionCatalog();
const result = validateRunnerPack(packJson);
if (!result.ok) throw new Error(result.errors.join("; "));
const executablePack = withRunnerPackRequires(result.pack);
```

Supported v1 actions:

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

Supported assertions:

- `url_contains`
- `url_matches`
- `text_visible`
- `request_seen`

## Example: Bing Search

```ts
const pack = {
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
      action: "key_press",
      target: "search_box",
      key: "Enter",
      locators: [{ strategy: "css", selector: "input[name=q]" }],
    },
    {
      action: "wait_for_url",
      target: "results_page",
      value: "**/search**",
    },
  ],
  success: [{ type: "url_contains", value: "/search" }],
};
```

## Login-Required Flow

For business systems that require login, the user logs in once inside the local AutoRecipe browser. Runner then reuses that local browser session:

```ts
const pack = {
  schema_version: "runner_pack_v1",
  intent: "crm.customer.search",
  entry_url: "https://crm.example.com/customers",
  params: {
    keyword: { type: "string", required: true },
  },
  steps: [
    {
      action: "fill_text",
      target: "customer_keyword",
      value: "{{keyword}}",
      locators: [{ strategy: "label", text: "客户名称" }],
    },
    {
      action: "click_text",
      target: "search_button",
      locators: [{ strategy: "text", text: "查询" }],
    },
  ],
  success: [{ type: "request_seen", path: "/api/customers/search", method: "POST" }],
};
```

Do not put usernames, passwords, tokens, cookies, or other credentials in pack params, logs, or result summaries.

## Boundaries

`runner_pack_v1` requires an explicit `http` or `https` `entry_url`. v1 does not execute arbitrary JavaScript, arbitrary Playwright code, shell commands, `visual` locators, or `coordinate` locators.
