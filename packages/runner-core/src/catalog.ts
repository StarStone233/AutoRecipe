import { createHash } from "node:crypto";
import { normalizePack, type RunnerAssertion, type RunnerLocator, type RunnerPack } from "./schema.js";

export const RUNNER_CORE_VERSION = "0.1.0";
export const RUNNER_CATALOG_VERSION = "0.1.0";

export type RunnerActionCatalog = {
  schema_version: "runner_action_catalog_v1";
  runner_core_version: string;
  runner_catalog_version: string;
  runner_catalog_hash: string;
  actions: Array<{ name: string; description: string; required?: string[]; optional?: string[] }>;
  locator_strategies: Array<{ name: RunnerLocator["strategy"]; description: string }>;
  assertions: Array<{ name: RunnerAssertion["type"]; description: string }>;
  security_boundaries: string[];
};

export type RunnerPackValidationResult = {
  ok: boolean;
  errors: string[];
  pack?: RunnerPack & { requires?: RunnerPackRequires };
};

export type RunnerPackRequires = {
  runner_core_version: string;
  runner_catalog_version: string;
};

const ACTIONS = [
  { name: "fill_text", description: "Fill a text-like control using a catalog-approved locator.", required: ["locators", "value"], optional: ["timeout_ms"] },
  { name: "click_text", description: "Click a visible element using css, role, label, or text locators.", required: ["locators"], optional: ["timeout_ms"] },
  { name: "submit_form", description: "Submit a form or form-like control.", required: ["locators"], optional: ["timeout_ms"] },
  { name: "key_press", description: "Press a keyboard key on the located element or page.", required: ["key"], optional: ["locators", "timeout_ms"] },
  { name: "wait_for_url", description: "Wait until the current URL matches the expected pattern.", required: ["value"], optional: ["timeout_ms"] },
] as const;

const LOCATORS = [
  { name: "css", description: "CSS selector locator." },
  { name: "role", description: "ARIA role and optional accessible name locator." },
  { name: "label", description: "Associated form label locator." },
  { name: "text", description: "Visible text locator." },
] as const;

const ASSERTIONS = [
  { name: "url_contains", description: "Passes when the final URL contains the given string." },
  { name: "url_matches", description: "Passes when the final URL matches the given regular expression." },
  { name: "text_visible", description: "Passes when the given text is visible." },
  { name: "request_seen", description: "Passes when a matching request was observed." },
] as const;

export function getRunnerActionCatalog(): RunnerActionCatalog {
  const withoutHash = {
    schema_version: "runner_action_catalog_v1" as const,
    runner_core_version: RUNNER_CORE_VERSION,
    runner_catalog_version: RUNNER_CATALOG_VERSION,
    runner_catalog_hash: "",
    actions: ACTIONS.map((item) => ({ ...item, required: [...(item.required || [])], optional: [...(item.optional || [])] })),
    locator_strategies: LOCATORS.map((item) => ({ ...item })),
    assertions: ASSERTIONS.map((item) => ({ ...item })),
    security_boundaries: [
      "runner_pack_v1 requires an explicit http(s) entry_url.",
      "Only catalog actions, locator strategies, and assertions are executable.",
      "Arbitrary JavaScript, Playwright code, shell commands, visual locators, and coordinate locators are not accepted in v1 generated packs.",
      "Credentials must not be passed through pack params, logs, or result summaries.",
    ],
  };
  return {
    ...withoutHash,
    runner_catalog_hash: catalogHash(withoutHash),
  };
}

export function validateRunnerPack(raw: unknown): RunnerPackValidationResult {
  const catalog = getRunnerActionCatalog();
  const actionNames = new Set(catalog.actions.map((item) => item.name));
  const locatorNames = new Set(catalog.locator_strategies.map((item) => item.name));
  const assertionNames = new Set(catalog.assertions.map((item) => item.name));
  const errors: string[] = [];
  let pack: RunnerPack;

  try {
    pack = normalizePack(raw);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  if (!/^https?:\/\//i.test(pack.entry_url)) {
    errors.push("entry_url must be an explicit http(s) URL");
  }
  for (const [index, step] of pack.steps.entries()) {
    if (!actionNames.has(step.action)) errors.push(`step ${index + 1}: unsupported action ${step.action}`);
    for (const locator of step.locators || []) {
      if (!locatorNames.has(locator.strategy)) {
        errors.push(`step ${index + 1}: unsupported locator strategy ${locator.strategy}`);
      }
    }
    for (const assertion of step.success || []) {
      if (!assertionNames.has(assertion.type)) errors.push(`step ${index + 1}: unsupported assertion ${assertion.type}`);
    }
  }
  for (const assertion of pack.success || []) {
    if (!assertionNames.has(assertion.type)) errors.push(`unsupported assertion ${assertion.type}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    pack: withRunnerPackRequires(pack),
  };
}

export function withRunnerPackRequires<T extends RunnerPack>(pack: T): T & { requires: RunnerPackRequires } {
  return {
    ...pack,
    requires: {
      runner_core_version: RUNNER_CORE_VERSION,
      runner_catalog_version: RUNNER_CATALOG_VERSION,
    },
  };
}

function catalogHash(catalog: Omit<RunnerActionCatalog, "runner_catalog_hash">): string {
  return createHash("sha256")
    .update(stableStringify(catalog))
    .digest("hex")
    .slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
