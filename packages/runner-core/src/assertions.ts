import { resolveLocator } from "./locatorResolver.js";
import type { PageLike } from "./pageTypes.js";
import type { RunnerAssertion } from "./schema.js";

export type CapturedRequest = {
  url: string;
  method: string;
  host: string;
  path: string;
};

export type AssertionTrace = {
  index: number;
  type: RunnerAssertion["type"];
  status: "passed" | "failed";
  error?: string;
};

export function attachRequestRecorder(page: PageLike, requests: CapturedRequest[]): () => void {
  if (!page.on) return () => {};
  const handler = (request: unknown) => {
    const row = request && typeof request === "object" ? request as Record<string, unknown> : {};
    const urlValue = callString(row, "url");
    if (!urlValue) return;
    try {
      const parsed = new URL(urlValue);
      requests.push({
        url: urlValue,
        method: callString(row, "method").toUpperCase() || "GET",
        host: parsed.hostname.toLowerCase(),
        path: parsed.pathname || "/",
      });
    } catch {
      requests.push({ url: urlValue, method: callString(row, "method").toUpperCase() || "GET", host: "", path: "" });
    }
  };
  page.on("request", handler);
  return () => {
    if (page.off) page.off("request", handler);
  };
}

export async function evaluateAssertions(
  page: PageLike,
  assertions: RunnerAssertion[],
  requests: CapturedRequest[],
): Promise<AssertionTrace[]> {
  const traces: AssertionTrace[] = [];
  for (let index = 0; index < assertions.length; index += 1) {
    const assertion = assertions[index];
    try {
      await evaluateAssertion(page, assertion, requests);
      traces.push({ index, type: assertion.type, status: "passed" });
    } catch (error) {
      traces.push({
        index,
        type: assertion.type,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return traces;
}

async function evaluateAssertion(page: PageLike, assertion: RunnerAssertion, requests: CapturedRequest[]): Promise<void> {
  if (assertion.type === "url_contains") {
    const current = page.url?.() || "";
    if (!current.includes(assertion.value)) throw new Error(`URL does not contain ${assertion.value}`);
    return;
  }
  if (assertion.type === "url_matches") {
    const current = page.url?.() || "";
    if (!new RegExp(assertion.pattern).test(current)) throw new Error(`URL does not match ${assertion.pattern}`);
    return;
  }
  if (assertion.type === "text_visible") {
    const locator = await resolveLocator(page, [{ strategy: "text", text: assertion.text }]);
    if (!locator.isVisible) return;
    if (!await locator.isVisible()) throw new Error(`Text is not visible: ${assertion.text}`);
    return;
  }
  if (assertion.type === "request_seen") {
    const expectedMethod = assertion.method?.toUpperCase();
    const matched = requests.some((request) => {
      return (!assertion.host || request.host === assertion.host.toLowerCase())
        && (!assertion.path || request.path === assertion.path)
        && (!expectedMethod || request.method === expectedMethod);
    });
    if (!matched) throw new Error(`Request was not seen: ${assertion.method || "*"} ${assertion.host || "*"}${assertion.path || "*"}`);
  }
}

function callString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "function") {
    const result = value.call(row);
    return typeof result === "string" ? result : "";
  }
  return typeof value === "string" ? value : "";
}
