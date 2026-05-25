export interface LLMConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  visionModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface PageClassification {
  page_type: "list" | "detail" | "form" | "dashboard" | "search" | "settings" | "login" | "other";
  page_description: string;
  confidence: number;
}

export interface ModuleAnnotation {
  business_purpose: string;
  data_entities: string[];
  confidence: number;
}

export interface CapabilityDescription {
  description: string;
  intent_category: "search" | "navigate" | "fill_form" | "login" | "browse" | "configure" | "other";
  confidence: number;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_VISION_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;

export function createLLMClient(config: LLMConfig) {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;
  const visionModel = config.visionModel || DEFAULT_VISION_MODEL;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

  async function callLLM(messages: Array<Record<string, unknown>>, useVision: boolean, maxTokens = 500): Promise<string> {
    const modelToUse = useVision ? visionModel : model;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: modelToUse,
            messages,
            temperature: 0.1,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
          throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content || "";
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (attempt < maxRetries) continue;
      }
    }
    throw lastError;
  }

  async function classifyPage(screenshotBase64: string | undefined, elementTexts: string[], url: string): Promise<PageClassification> {
    const elementList = elementTexts.slice(0, 20).map((t, i) => `${i + 1}. ${t}`).join("\n");
    const prompt = `Classify this web page. URL: ${url}

Visible elements:
${elementList}

Respond with JSON only:
{"page_type": "<list|detail|form|dashboard|search|settings|login|other>", "page_description": "<one sentence>", "confidence": <0-1>}`;

    const messages: Array<Record<string, unknown>> = [];
    if (screenshotBase64) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
        ],
      });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    try {
      const raw = await callLLM(messages, !!screenshotBase64);
      const json = extractJSON(raw);
      return {
        page_type: PAGE_TYPES.includes(json.page_type as string) ? (json.page_type as PageClassification["page_type"]) : "other",
        page_description: String(json.page_description || "").slice(0, 200),
        confidence: Math.max(0, Math.min(1, Number(json.confidence) || 0.5)),
      };
    } catch {
      return { page_type: "other", page_description: "", confidence: 0 };
    }
  }

  async function classifyPagesBatch(
    pages: Array<{ page_id: string; page_url: string; screenshotBase64?: string; elementTexts: string[] }>,
  ): Promise<Map<string, PageClassification>> {
    const results = new Map<string, PageClassification>();
    if (!pages.length) return results;

    const pageList = pages.map((p, i) =>
      `${i + 1}. ID:${p.page_id} URL:${p.page_url} elements:[${p.elementTexts.slice(0, 15).join(", ")}]`
    ).join("\n");

    const prompt = `Classify each web page below. Return a JSON array, one object per page in order.

${pageList}

Respond with JSON only:
[{"page_id":"<id>","page_type":"<list|detail|form|dashboard|search|settings|login|other>","page_description":"<one sentence>","confidence":<0-1>}, ...]`;

    const messages: Array<Record<string, unknown>> = [];
    const images = pages.map((p) => p.screenshotBase64).filter(Boolean);
    if (images.length) {
      const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
      for (const img of images.slice(0, 6)) {
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img}` } });
      }
      messages.push({ role: "user", content });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    try {
      const raw = await callLLM(messages, images.length > 0, Math.min(pages.length * 150, 1200));
      const arr = extractJSONArray(raw);
      for (const item of arr) {
        const pageId = String(item.page_id || "");
        if (!pageId) continue;
        results.set(pageId, {
          page_type: PAGE_TYPES.includes(item.page_type as string) ? (item.page_type as PageClassification["page_type"]) : "other",
          page_description: String(item.page_description || "").slice(0, 200),
          confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
        });
      }
    } catch {
      // fall back to individual classification on batch failure
    }

    for (const page of pages) {
      if (!results.has(page.page_id)) {
        results.set(page.page_id, { page_type: "other", page_description: "", confidence: 0 });
      }
    }
    return results;
  }

  async function annotateModulesBatch(
    modules: Array<{ module_id: string; title: string; actions: string[]; pageTypes: string[]; region: string }>,
  ): Promise<Array<{ module_id: string } & ModuleAnnotation>> {
    if (!modules.length) return [];

    const moduleList = modules.map((m, i) =>
      `${i + 1}. ID:${m.module_id} title:"${m.title}" actions:[${m.actions.join(", ")}] pages:[${m.pageTypes.join(", ")}] region:${m.region}`
    ).join("\n");

    const prompt = `Annotate each navigation module's business purpose below. Return a JSON array, one object per module in order.

${moduleList}

Respond with JSON only:
[{"module_id":"<id>","business_purpose":"<one sentence>","data_entities":["<entity>",...],"confidence":<0-1>}, ...]`;

    try {
      const raw = await callLLM([{ role: "user", content: prompt }], false, Math.min(modules.length * 120, 800));
      const arr = extractJSONArray(raw);
      return arr.map((item) => ({
        module_id: String(item.module_id || ""),
        business_purpose: String(item.business_purpose || "").slice(0, 300),
        data_entities: Array.isArray(item.data_entities) ? item.data_entities.map(String).slice(0, 10) : [],
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
      }));
    } catch {
      return modules.map((m) => ({
        module_id: m.module_id,
        business_purpose: "",
        data_entities: [],
        confidence: 0,
      }));
    }
  }

  async function annotateModule(title: string, actionLabels: string[], pageTypes: string[], region: string): Promise<ModuleAnnotation> {
    const prompt = `Summarize this navigation module's business purpose.

Module title: ${title}
Actions: ${actionLabels.slice(0, 10).join(", ")}
Related page types: ${pageTypes.join(", ")}
Region: ${region}

Respond with JSON only:
{"business_purpose": "<one sentence>", "data_entities": ["<entity1>", "<entity2>"], "confidence": <0-1>}`;

    try {
      const raw = await callLLM([{ role: "user", content: prompt }], false);
      const json = extractJSON(raw);
      return {
        business_purpose: String(json.business_purpose || "").slice(0, 300),
        data_entities: Array.isArray(json.data_entities) ? json.data_entities.map(String).slice(0, 10) : [],
        confidence: Math.max(0, Math.min(1, Number(json.confidence) || 0.5)),
      };
    } catch {
      return { business_purpose: "", data_entities: [], confidence: 0 };
    }
  }

  return { classifyPage, classifyPagesBatch, annotateModule, annotateModulesBatch };
}

const INTENT_CATEGORIES = ["search", "navigate", "fill_form", "login", "browse", "configure", "other"];

export async function describeCapability(
  config: LLMConfig,
  systemName: string,
  capabilityName: string,
  actionLabels: string[],
  pageTypes: string[],
): Promise<CapabilityDescription> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  const prompt = `Describe this system capability for an operation manual.

System: ${systemName}
Capability: ${capabilityName}
Actions: ${actionLabels.join(", ")}
Page types: ${pageTypes.join(", ")}

Respond with JSON only:
{"description": "<one sentence describing what this capability does>", "intent_category": "<search|navigate|fill_form|login|browse|configure|other>", "confidence": <0-1>}`;

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`LLM API error: ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content || "";
    const json = extractJSON(raw);
    return {
      description: String(json.description || "").slice(0, 300),
      intent_category: INTENT_CATEGORIES.includes(json.intent_category as string) ? (json.intent_category as CapabilityDescription["intent_category"]) : "other",
      confidence: Math.max(0, Math.min(1, Number(json.confidence) || 0.5)),
    };
  } catch {
    return { description: "", intent_category: "other", confidence: 0 };
  }
}

const PAGE_TYPES = ["list", "detail", "form", "dashboard", "search", "settings", "login", "other"];

function extractJSON(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

function extractJSONArray(text: string): Array<Record<string, unknown>> {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

export function compressScreenshotBase64(base64: string, maxWidth = 512, quality = 0.4): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const img = new (globalThis as unknown as { Image: typeof Image }).Image
        ? new Image()
        : null;
      if (!img) {
        resolve(base64);
        return;
      }
      img.onload = () => {
        const canvas = (typeof document !== "undefined" ? document.createElement("canvas") : null) as HTMLCanvasElement | null;
        if (!canvas) { resolve(base64); return; }
        const scale = Math.min(1, maxWidth / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(base64); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality).replace(/^data:image\/jpeg;base64,/, ""));
      };
      img.onerror = () => resolve(base64);
      img.src = `data:image/png;base64,${base64}`;
    } catch {
      resolve(base64);
    }
  });
}
