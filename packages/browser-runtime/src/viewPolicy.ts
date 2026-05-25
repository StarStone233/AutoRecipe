export const PERSONAL_RAIL_WIDTH = 64;
export const PERSONAL_SIDEBAR_WIDTH = 430;
export const PERSONAL_COLLAPSED_WINDOW_WIDTH = 460;
export const PERSONAL_EXPANDED_WINDOW_WIDTH = 1320;
export const BUSINESS_VIEW_STABLE_ZOOM = 1;
export const PERFORMANCE_CAPTURE_POLICY = {
  snapshotIntervalMs: 30000,
  layoutSnapshotIntervalMs: 10000,
  allowConcurrentSnapshots: false,
} as const;

export const HORIZONTAL_FIT_SCROLL_CSS = `
  html {
    overflow-x: hidden !important;
  }
  body {
    max-width: 100vw !important;
    overflow-x: hidden !important;
  }
  img,
  video,
  canvas,
  table,
  iframe {
    max-width: 100% !important;
  }
`;

export type BusinessViewBoundsInput = {
  width: number;
  height: number;
  visible: boolean;
  sidebarExpanded: boolean;
};

export type BusinessViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function businessViewBounds(input: BusinessViewBoundsInput): BusinessViewBounds {
  if (!input.visible) {
    return { x: 0, y: input.height + 20, width: 1, height: 1 };
  }
  const sideWidth = input.sidebarExpanded ? PERSONAL_SIDEBAR_WIDTH : PERSONAL_RAIL_WIDTH;
  return {
    x: sideWidth,
    y: 0,
    width: Math.max(100, input.width - sideWidth),
    height: Math.max(100, input.height),
  };
}

export function businessViewZoom(_viewWidth: number): number {
  return BUSINESS_VIEW_STABLE_ZOOM;
}

export type WindowResizeIntentInput = {
  visible: boolean;
  windowWidth: number;
  windowHeight: number;
};

export type WorkspaceResizeIntentInput = {
  expanded: boolean;
  businessVisible: boolean;
  windowWidth: number;
  windowHeight: number;
};

export type WindowResizeIntent = {
  width: number;
  height: number;
  animate: boolean;
};

export function windowResizeIntentForBusinessView(input: WindowResizeIntentInput): WindowResizeIntent | undefined {
  if (input.visible && input.windowWidth < PERSONAL_EXPANDED_WINDOW_WIDTH) {
    return {
      width: PERSONAL_EXPANDED_WINDOW_WIDTH,
      height: input.windowHeight,
      animate: true,
    };
  }
  if (!input.visible && input.windowWidth > PERSONAL_COLLAPSED_WINDOW_WIDTH + 80) {
    return {
      width: PERSONAL_COLLAPSED_WINDOW_WIDTH,
      height: input.windowHeight,
      animate: true,
    };
  }
  return undefined;
}

export function windowResizeIntentForWorkspaceExpansion(input: WorkspaceResizeIntentInput): WindowResizeIntent | undefined {
  if (input.expanded && input.windowWidth < PERSONAL_EXPANDED_WINDOW_WIDTH) {
    return {
      width: PERSONAL_EXPANDED_WINDOW_WIDTH,
      height: input.windowHeight,
      animate: true,
    };
  }
  if (!input.expanded && !input.businessVisible && input.windowWidth > PERSONAL_COLLAPSED_WINDOW_WIDTH + 80) {
    return {
      width: PERSONAL_COLLAPSED_WINDOW_WIDTH,
      height: input.windowHeight,
      animate: true,
    };
  }
  return undefined;
}
