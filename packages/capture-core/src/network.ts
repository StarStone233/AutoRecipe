import { URL } from "node:url";
import { normalizePathTemplate } from "@autorecipe/knowledge-core";

export type NetworkEventInput = {
  tabId: number;
  pageUrl: string;
  url: string;
  method: string;
  statusCode: number;
  resourceType?: string;
  startedAtMs: number;
  completedAtMs: number;
  interactionRef?: Record<string, unknown>;
};

export function toNetworkCompletedEvent(input: NetworkEventInput): Record<string, unknown> | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
  return {
    event_type: "network_completed",
    url: input.url,
    ts: new Date(input.completedAtMs).toISOString(),
    payload: {
      tab_id: input.tabId,
      bound_tab_id: input.tabId,
      page_url: input.pageUrl,
      url: input.url,
      method: input.method.toUpperCase(),
      status_code: input.statusCode,
      resource_type: normalizeResourceType(input.resourceType || "xhr"),
      path_template: normalizePathTemplate(parsed.pathname || "/"),
      query_keys: queryKeys,
      latency_ms: Math.max(0, input.completedAtMs - input.startedAtMs),
      ...(input.interactionRef ? { interaction_ref: input.interactionRef } : {}),
    },
  };
}

function normalizeResourceType(value: string): string {
  const text = value.toLowerCase();
  if (text.includes("xhr")) return "xhr";
  if (text.includes("fetch")) return "fetch";
  return text || "other";
}
