import { attachRequestRecorder, evaluateAssertions, type AssertionTrace, type CapturedRequest } from "./assertions.js";
import { resolveLocator } from "./locatorResolver.js";
import type { PageLike } from "./pageTypes.js";
import { normalizePack, RunnerPackSchema, RunnerStep, type RunnerPack, type RunnerParams } from "./schema.js";
import { renderTemplate } from "./template.js";

export type RunnerStepTrace = {
  index: number;
  action: RunnerStep["action"];
  target: string;
  status: "passed" | "failed";
  error?: string;
};

export type RunnerTrace = {
  status: "passed" | "failed";
  intent: string;
  steps: RunnerStepTrace[];
  assertions: AssertionTrace[];
  requests: CapturedRequest[];
};

export type RunPackOptions = {
  page: PageLike;
  params?: RunnerParams;
  navigate?: boolean;
  throwOnError?: boolean;
};

export async function runPack(packInput: unknown, options: RunPackOptions): Promise<RunnerTrace> {
  const pack = RunnerPackSchema.parse(normalizePack(packInput));
  const params = resolveParams(pack, options.params || {});
  const steps: RunnerStepTrace[] = [];
  const requests: CapturedRequest[] = [];
  const detachRecorder = attachRequestRecorder(options.page, requests);

  try {
    if (options.navigate !== false && pack.entry_url && options.page.goto) {
      await options.page.goto(pack.entry_url);
    }

    for (let index = 0; index < pack.steps.length; index += 1) {
      const step = pack.steps[index];
      const trace = await runStep(options.page, step, params, index);
      steps.push(trace);
      if (trace.status === "failed") {
        if (options.throwOnError) throw new Error(trace.error || "Step failed");
        return { status: "failed", intent: pack.intent, steps, assertions: [], requests };
      }
    }
    const assertions = await evaluateAssertions(options.page, pack.success, requests);
    const status = assertions.some((assertion) => assertion.status === "failed") ? "failed" : "passed";
    return { status, intent: pack.intent, steps, assertions, requests };
  } catch (error) {
    if (options.throwOnError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", intent: pack.intent, steps: steps.length ? steps : [{ index: 0, action: pack.steps[0]?.action || "click_text", target: pack.steps[0]?.target || "", status: "failed", error: message }], assertions: [], requests };
  } finally {
    detachRecorder();
  }
}

async function runStep(page: PageLike, step: RunnerStep, params: RunnerParams, index: number): Promise<RunnerStepTrace> {
  try {
    if (step.action === "wait_for_url") {
      if (!page.waitForURL) throw new Error("Page does not support waitForURL");
      await page.waitForURL(renderTemplate(step.value || "", params), { timeout: step.timeout_ms });
      return passed(step, index);
    }

    const locator = await resolveLocator(page, step.locators);
    if (step.action === "fill_text") {
      if (!locator.fill) throw new Error("Locator does not support fill");
      await locator.fill(renderTemplate(step.value || "", params), { timeout: step.timeout_ms });
    } else if (step.action === "key_press") {
      if (!locator.press) throw new Error("Locator does not support press");
      await locator.press(renderTemplate(step.key || step.value || "", params), { timeout: step.timeout_ms });
    } else {
      if (!locator.click) throw new Error("Locator does not support click");
      await locator.click({ timeout: step.timeout_ms });
    }
    return passed(step, index);
  } catch (error) {
    return {
      index,
      action: step.action,
      target: step.target,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveParams(pack: RunnerPack, params: RunnerParams): RunnerParams {
  const resolved: RunnerParams = { ...params };
  for (const [key, spec] of Object.entries(pack.params)) {
    if (resolved[key] === undefined && spec.default !== undefined) resolved[key] = spec.default;
    if (spec.required && resolved[key] === undefined) throw new Error(`Missing required param: ${key}`);
  }
  return resolved;
}

function passed(step: RunnerStep, index: number): RunnerStepTrace {
  return { index, action: step.action, target: step.target, status: "passed" };
}
