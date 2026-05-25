import { ipcRenderer } from "electron";

let disposeCapture: (() => void) | undefined;

ipcRenderer.on("autorecipe:capture-started", (_event, payload: { tabId: number }) => {
  disposeCapture?.();
  disposeCapture = installDomCapture((event) => {
    ipcRenderer.send("autorecipe:capture-event", event);
  }, { tabId: payload.tabId });
});

ipcRenderer.on("autorecipe:capture-stopped", () => {
  disposeCapture?.();
  disposeCapture = undefined;
});

type DomCaptureEmit = (event: {
  event_type: string;
  url: string;
  ts: string;
  payload: Record<string, unknown>;
}) => void;

function installDomCapture(emit: DomCaptureEmit, options: { tabId: number }): () => void {
  const tabId = options.tabId;
  const disposers: Array<() => void> = [];
  let lastUrl = location.href;
  let inputTimer: number | undefined;
  const compositionTargets = new WeakSet<EventTarget>();

  const basePayload = (): Record<string, unknown> => ({
    tab_id: tabId,
    page_url: location.href,
    document_url: document.URL,
    title: document.title,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
  });

  const send = (event_type: string, payload: Record<string, unknown> = {}) => {
    emit({
      event_type,
      url: location.href,
      ts: new Date().toISOString(),
      payload: { ...basePayload(), ...payload },
    });
  };

  const onClick = (event: MouseEvent) => send("ui_click", elementPayload(event.target));
  document.addEventListener("click", onClick, true);
  disposers.push(() => document.removeEventListener("click", onClick, true));

  const emitInput = (target: EventTarget | null) => {
    window.clearTimeout(inputTimer);
    inputTimer = window.setTimeout(() => send("ui_input", elementPayload(target)), 350);
  };

  const onCompositionStart = (event: CompositionEvent) => {
    if (event.target) compositionTargets.add(event.target);
    window.clearTimeout(inputTimer);
  };
  document.addEventListener("compositionstart", onCompositionStart, true);
  disposers.push(() => document.removeEventListener("compositionstart", onCompositionStart, true));

  const onCompositionEnd = (event: CompositionEvent) => {
    if (event.target) compositionTargets.delete(event.target);
    emitInput(event.target);
  };
  document.addEventListener("compositionend", onCompositionEnd, true);
  disposers.push(() => document.removeEventListener("compositionend", onCompositionEnd, true));

  const onInput = (event: Event) => {
    if ((event instanceof InputEvent && event.isComposing) || (event.target && compositionTargets.has(event.target))) return;
    emitInput(event.target);
  };
  document.addEventListener("input", onInput, true);
  disposers.push(() => document.removeEventListener("input", onInput, true));

  const onChange = (event: Event) => send(event.target instanceof HTMLSelectElement ? "ui_select" : "ui_change", elementPayload(event.target));
  document.addEventListener("change", onChange, true);
  disposers.push(() => document.removeEventListener("change", onChange, true));

  const onSubmit = (event: Event) => send("ui_submit", elementPayload(event.target));
  document.addEventListener("submit", onSubmit, true);
  disposers.push(() => document.removeEventListener("submit", onSubmit, true));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || (event.target && compositionTargets.has(event.target))) return;
    if (!new Set(["Enter", "Escape", "Tab", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]).has(event.key)) return;
    send("ui_keydown", { ...elementPayload(event.target), key: event.key });
  };
  document.addEventListener("keydown", onKeyDown, true);
  disposers.push(() => document.removeEventListener("keydown", onKeyDown, true));

  const urlTimer = window.setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      send("url_change");
    }
  }, 500);
  disposers.push(() => window.clearInterval(urlTimer));

  const layoutTimer = window.setInterval(() => {
    send("layout_snapshot", { regions: inferLayoutRegions() });
  }, 10000);
  disposers.push(() => window.clearInterval(layoutTimer));

  send("page_loaded", { ready_state: document.readyState });
  send("layout_snapshot", { regions: inferLayoutRegions() });
  return () => disposers.splice(0).forEach((dispose) => dispose());
}

function elementPayload(target: EventTarget | null): Record<string, unknown> {
  const element = target instanceof Element ? target : null;
  if (!element) return {};
  const rect = element.getBoundingClientRect();
  const label = compactText(
    element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.getAttribute("data-testid")
      || directText(element)
      || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : "")
      || element.tagName.toLowerCase(),
  );
  const region = inferRegionFromElement(element, rect);
  return {
    label,
    text: label,
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || "",
    class_name: element.getAttribute("class") || "",
    element_id: element.id || "",
    data_testid: element.getAttribute("data-testid") || "",
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    x_pct: window.innerWidth ? ((rect.left + rect.width / 2) / window.innerWidth) * 100 : 0,
    y_pct: window.innerHeight ? ((rect.top + rect.height / 2) / window.innerHeight) * 100 : 0,
    w_pct: window.innerWidth ? (rect.width / window.innerWidth) * 100 : 0,
    h_pct: window.innerHeight ? (rect.height / window.innerHeight) * 100 : 0,
    region,
    direct_text: directText(element),
  };
}

function compactText(value: string, max = 180): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function directText(el: Element | null): string {
  if (!el) return "";
  const parts: string[] = [];
  for (const child of el.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const text = (child.textContent || "").replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
  }
  if (!parts.length) {
    for (const child of el.children) {
      if (child.children.length === 0) {
        const text = (child.textContent || "").replace(/\s+/g, " ").trim();
        if (text) parts.push(text);
      }
    }
  }
  return parts.join(" ").slice(0, 160);
}

function inferRegionFromElement(el: Element | null, rect: DOMRect | null | undefined): string {
  if (!el) return "main_content";
  const classText = (el.getAttribute("class") || "").toLowerCase();
  const roleText = (el.getAttribute("role") || "").toLowerCase();
  const combined = `${classText} ${roleText}`;
  if (/header|navbar|breadcrumb|top/.test(combined)) return "top_bar";
  if (/sidebar|sider|menu|navigation|tree|left/.test(combined)) return "left_nav";
  if (/filter|search|query|form/.test(combined)) return "filter_panel";
  if (/table|grid|result|list/.test(combined)) return "result_table";
  if (/dialog|modal|popup|drawer/.test(combined)) return "modal_dialog";
  if (!rect || !window.innerWidth || !window.innerHeight) return "main_content";
  if (rect.top < window.innerHeight * 0.16) return "top_bar";
  if (rect.left < window.innerWidth * 0.2) return "left_nav";
  if (rect.left > window.innerWidth * 0.82) return "right_panel";
  return "main_content";
}

function inferLayoutRegions(): Array<Record<string, unknown>> {
  const candidates = [
    ["top_bar", "header,[role=banner],nav,.navbar,.toolbar"],
    ["left_nav", "aside,[role=navigation],.sidebar,.sider,.menu"],
    ["main_content", "main,[role=main],.content,.main"],
    ["modal_dialog", "[role=dialog],.modal,.dialog,.drawer"],
  ] as const;
  const rows: Array<Record<string, unknown>> = [];
  for (const [region, selector] of candidates) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    rows.push({
      region,
      x_pct: window.innerWidth ? (rect.left / window.innerWidth) * 100 : 0,
      y_pct: window.innerHeight ? (rect.top / window.innerHeight) * 100 : 0,
      width_pct: window.innerWidth ? (rect.width / window.innerWidth) * 100 : 0,
      height_pct: window.innerHeight ? (rect.height / window.innerHeight) * 100 : 0,
      confidence: 0.72,
      source: "electron_preload",
      selector_hint: selector,
      recognized_by: ["dom_selector"],
    });
  }
  return rows;
}
