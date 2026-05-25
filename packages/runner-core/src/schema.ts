import { z } from "zod";

export const RunnerParamSchema = z.object({
  type: z.enum(["string", "number", "boolean"]).default("string"),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().default(""),
});

export const RunnerLocatorSchema = z.object({
  strategy: z.enum(["css", "role", "label", "text", "visual", "coordinate"]),
  selector: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  exact: z.boolean().optional(),
  confidence: z.number().optional(),
}).passthrough();

export const RunnerAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_contains"), value: z.string() }),
  z.object({ type: z.literal("url_matches"), pattern: z.string() }),
  z.object({ type: z.literal("text_visible"), text: z.string() }),
  z.object({
    type: z.literal("request_seen"),
    host: z.string().optional(),
    path: z.string().optional(),
    method: z.string().optional(),
  }),
]);

export const RunnerStepSchema = z.object({
  action: z.enum(["fill_text", "click_text", "submit_form", "key_press", "wait_for_url"]),
  target: z.string().default(""),
  value: z.string().optional(),
  key: z.string().optional(),
  timeout_ms: z.number().default(5000),
  locators: z.array(RunnerLocatorSchema).default([]),
  success: z.array(RunnerAssertionSchema).default([]),
}).passthrough();

export const RunnerPackSchema = z.object({
  schema_version: z.literal("runner_pack_v1"),
  intent: z.string(),
  title: z.string().default(""),
  entry_url: z.string().default(""),
  params: z.record(RunnerParamSchema).default({}),
  steps: z.array(RunnerStepSchema).default([]),
  success: z.array(RunnerAssertionSchema).default([]),
}).passthrough();

export type RunnerPack = z.infer<typeof RunnerPackSchema>;
export type RunnerStep = z.infer<typeof RunnerStepSchema>;
export type RunnerLocator = z.infer<typeof RunnerLocatorSchema>;
export type RunnerAssertion = z.infer<typeof RunnerAssertionSchema>;
export type RunnerParams = Record<string, string | number | boolean>;

type RawRecord = Record<string, unknown>;

export function normalizePack(raw: unknown): RunnerPack {
  const row = toRecord(raw);
  if (row.schema_version === "runner_pack_v1") return RunnerPackSchema.parse(row);

  const systemKey = text(row.system_key) || "system";
  const recipeId = text(row.recipe_id) || text(row.pack_id) || "captured_flow";
  const rawSteps = arrayOfRecords(row.steps);
  const steps = rawSteps.map(normalizeRecipeStep);
  const pack = {
    schema_version: "runner_pack_v1",
    intent: `${systemKey}.${recipeId}`,
    title: text(row.title),
    entry_url: text(row.entry_url) || "",
    params: inferParams(steps),
    steps,
    success: normalizeMatchedRequests(row.matched_requests),
  };
  return RunnerPackSchema.parse(pack);
}

function normalizeRecipeStep(step: RawRecord): RunnerStep {
  const action = normalizeAction(text(step.action));
  const semantic = text(step.semantic_action);
  const rawText = text(step.text);
  const locators = arrayOfRecords(step.locator_candidates)
    .map(normalizeLocator)
    .filter((locator): locator is NonNullable<ReturnType<typeof normalizeLocator>> => Boolean(locator))
    .sort((left, right) => locatorRank(left.strategy) - locatorRank(right.strategy));
  const value = action === "fill_text" ? "{{query}}" : undefined;
  const target = text(step.target) || text(step.element_id) || semantic || rawText || action;
  return RunnerStepSchema.parse({
    action,
    target,
    value,
    key: action === "key_press" ? rawText || semantic : undefined,
    locators,
    success: normalizeSuccessCriteria(step.success_criteria),
  });
}

function normalizeAction(value: string): RunnerStep["action"] {
  if (value === "fill_text" || value === "submit_form" || value === "key_press" || value === "wait_for_url") return value;
  return "click_text";
}

function normalizeLocator(row: RawRecord): RunnerLocator | undefined {
  const strategy = text(row.strategy);
  if (strategy === "visual" || strategy === "coordinate") return undefined;
  if (strategy === "css" && text(row.selector)) {
    return RunnerLocatorSchema.parse({ strategy, selector: text(row.selector), confidence: numberOrUndefined(row.confidence) });
  }
  if (strategy === "role" && text(row.role)) {
    return RunnerLocatorSchema.parse({ strategy, role: text(row.role), name: text(row.name), exact: boolOrUndefined(row.exact), confidence: numberOrUndefined(row.confidence) });
  }
  if (strategy === "label") {
    return RunnerLocatorSchema.parse({ strategy, text: text(row.text) || text(row.name), exact: boolOrUndefined(row.exact), confidence: numberOrUndefined(row.confidence) });
  }
  if (strategy === "text") {
    return RunnerLocatorSchema.parse({ strategy, text: text(row.text) || text(row.name), exact: boolOrUndefined(row.exact), confidence: numberOrUndefined(row.confidence) });
  }
  return undefined;
}

function locatorRank(strategy: RunnerLocator["strategy"]): number {
  return { css: 1, role: 2, label: 3, text: 4, visual: 5, coordinate: 6 }[strategy] || 9;
}

function inferParams(steps: RunnerStep[]): RunnerPack["params"] {
  return steps.some((step) => step.action === "fill_text" && step.value === "{{query}}")
    ? { query: { type: "string", required: true, description: "Search or form input text." } }
    : {};
}

function normalizeMatchedRequests(value: unknown): RunnerAssertion[] {
  return arrayOfRecords(value)
    .map((request) => {
      if (request.is_effective === false) return undefined;
      const host = text(request.host);
      const path = text(request.path_template) || text(request.path);
      const method = text(request.method).toUpperCase();
      if (!host && !path) return undefined;
      return RunnerAssertionSchema.parse({
        type: "request_seen",
        host: host || undefined,
        path: path || undefined,
        method: method || undefined,
      });
    })
    .filter((item): item is RunnerAssertion => Boolean(item));
}

function normalizeSuccessCriteria(value: unknown): RunnerAssertion[] {
  return stringArray(value)
    .map((item) => {
      const parts = item.startsWith("request:") ? item.slice("request:".length).split(":") : [];
      if (parts.length < 2) return undefined;
      return RunnerAssertionSchema.parse({ type: "request_seen", method: parts[0], path: parts[1] });
    })
    .filter((item): item is RunnerAssertion => Boolean(item));
}

function toRecord(value: unknown): RawRecord {
  return value && typeof value === "object" ? value as RawRecord : {};
}

function arrayOfRecords(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as RawRecord[] : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
