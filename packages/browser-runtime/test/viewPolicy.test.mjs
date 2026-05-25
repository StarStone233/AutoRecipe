import assert from "node:assert/strict";
import test from "node:test";
import {
  businessViewBounds,
  businessViewZoom,
  HORIZONTAL_FIT_SCROLL_CSS,
  PERFORMANCE_CAPTURE_POLICY,
  windowResizeIntentForBusinessView,
  windowResizeIntentForWorkspaceExpansion,
} from "../dist/viewPolicy.js";

test("keeps business view width stable beside the personal sidebar", () => {
  assert.deepEqual(businessViewBounds({ width: 1320, height: 780, visible: true, sidebarExpanded: true }), {
    x: 430,
    y: 0,
    width: 890,
    height: 780,
  });
  assert.deepEqual(businessViewBounds({ width: 460, height: 780, visible: false, sidebarExpanded: false }), {
    x: 0,
    y: 800,
    width: 1,
    height: 1,
  });
});

test("uses only the rail width when AutoRecipe controls are collapsed", () => {
  assert.deepEqual(businessViewBounds({ width: 1320, height: 780, visible: true, sidebarExpanded: false }), {
    x: 64,
    y: 0,
    width: 1256,
    height: 780,
  });
});

test("uses a stable page zoom instead of resizing zoom with the window", () => {
  assert.equal(businessViewZoom(640), 1);
  assert.equal(businessViewZoom(890), 1);
  assert.equal(businessViewZoom(1280), 1);
});

test("expands the host window when showing the business browser", () => {
  assert.deepEqual(windowResizeIntentForBusinessView({ visible: true, windowWidth: 460, windowHeight: 780 }), {
    width: 1320,
    height: 780,
    animate: true,
  });
  assert.deepEqual(windowResizeIntentForBusinessView({ visible: true, windowWidth: 920, windowHeight: 780 }), {
    width: 1320,
    height: 780,
    animate: true,
  });
  assert.equal(windowResizeIntentForBusinessView({ visible: true, windowWidth: 1320, windowHeight: 780 }), undefined);
});

test("collapses the host window after hiding the business browser", () => {
  assert.deepEqual(windowResizeIntentForBusinessView({ visible: false, windowWidth: 1320, windowHeight: 780 }), {
    width: 460,
    height: 780,
    animate: true,
  });
  assert.equal(windowResizeIntentForBusinessView({ visible: false, windowWidth: 460, windowHeight: 780 }), undefined);
});

test("expands the host window when showing the assets workspace", () => {
  assert.deepEqual(windowResizeIntentForWorkspaceExpansion({
    expanded: true,
    businessVisible: false,
    windowWidth: 460,
    windowHeight: 780,
  }), {
    width: 1320,
    height: 780,
    animate: true,
  });
  assert.equal(windowResizeIntentForWorkspaceExpansion({
    expanded: false,
    businessVisible: true,
    windowWidth: 1320,
    windowHeight: 780,
  }), undefined);
  assert.deepEqual(windowResizeIntentForWorkspaceExpansion({
    expanded: false,
    businessVisible: false,
    windowWidth: 1320,
    windowHeight: 780,
  }), {
    width: 460,
    height: 780,
    animate: true,
  });
});

test("allows vertical page scroll while suppressing horizontal overflow", () => {
  assert.match(HORIZONTAL_FIT_SCROLL_CSS, /overflow-x:\s*hidden/i);
  assert.doesNotMatch(HORIZONTAL_FIT_SCROLL_CSS, /overflow-y:\s*hidden/i);
  assert.doesNotMatch(HORIZONTAL_FIT_SCROLL_CSS, /::-webkit-scrollbar[\s\S]*display:\s*none/i);
});

test("uses low-frequency visual capture during mining to keep the page responsive", () => {
  assert.equal(PERFORMANCE_CAPTURE_POLICY.snapshotIntervalMs >= 30000, true);
  assert.equal(PERFORMANCE_CAPTURE_POLICY.layoutSnapshotIntervalMs >= 10000, true);
  assert.equal(PERFORMANCE_CAPTURE_POLICY.allowConcurrentSnapshots, false);
});
