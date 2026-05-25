export type DomCaptureEmit = (event: {
  event_type: string;
  url: string;
  ts: string;
  payload: Record<string, unknown>;
}) => void;

export type DomCaptureOptions = {
  tabId: number;
  visualIntervalMs?: number;
};

export function installDomCapture(emit: DomCaptureEmit, options: DomCaptureOptions): () => void {
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

  const elementPayload = (target: EventTarget | null): Record<string, unknown> => {
    const element = target instanceof Element ? target : null;
    if (!element) return {};
    const rect = element.getBoundingClientRect();
    const label = compactText(
      element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.textContent
      || (element as HTMLInputElement).value
      || element.tagName.toLowerCase(),
    );
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
    };
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

  const onChange = (event: Event) => send("ui_change", elementPayload(event.target));
  document.addEventListener("change", onChange, true);
  disposers.push(() => document.removeEventListener("change", onChange, true));

  const onSubmit = (event: Event) => send("ui_submit", elementPayload(event.target));
  document.addEventListener("submit", onSubmit, true);
  disposers.push(() => document.removeEventListener("submit", onSubmit, true));

  const urlTimer = window.setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      send("url_change");
    }
  }, 500);
  disposers.push(() => window.clearInterval(urlTimer));

  const layoutTimer = window.setInterval(() => {
    send("layout_snapshot", { regions: inferLayoutRegions() });
  }, 3000);
  disposers.push(() => window.clearInterval(layoutTimer));

  send("page_loaded", { ready_state: document.readyState });
  return () => disposers.splice(0).forEach((dispose) => dispose());
}

function compactText(value: string, max = 180): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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
