import assert from "node:assert/strict";
import test from "node:test";

import { analyzeAuthSnapshot, shouldNavigateForAuthTarget, sanitizeStorageSignals } from "../dist/authState.js";

test("detects login page as auth required", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "secure_example",
    url: "https://secure.example/login?redirect=/app",
    title: "Login",
    text: "Sign in Password Remember me",
    selectors: [],
    storageKeys: ["session_token"],
  });

  assert.equal(result.status, "required");
  assert.equal(result.sensitive_values_stored, false);
  assert.equal(result.signals.some((signal) => signal.name === "login_url"), true);
});

test("detects application shell as auth ready", () => {
  const result = analyzeAuthSnapshot({
    profileId: "work",
    systemKey: "secure_example",
    url: "https://secure.example/app/dashboard",
    title: "Dashboard",
    text: "Dashboard Projects Settings",
    selectors: ["[data-testid=\"user-menu\"]", "main"],
    storageKeys: ["session_token", "theme"],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.profile_id, "work");
  assert.equal(result.verified_url, "https://secure.example/app/dashboard");
  assert.equal(result.signals.some((signal) => signal.kind === "selector" && signal.matched), true);
});

test("storage signal sanitizer redacts keys and drops values", () => {
  const signals = sanitizeStorageSignals({
    session_token: "secret-token-value",
    refreshToken: "secret-refresh-value",
    theme: "dark",
  });

  assert.deepEqual(signals.map((signal) => signal.detail).sort(), ["storage:general", "storage:sensitive", "storage:sensitive"]);
  assert.equal(signals.some((signal) => String(signal.detail).includes("secret")), false);
});

test("returns unknown for ambiguous pages", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "secure_example",
    url: "https://secure.example/login",
    title: "Dashboard",
    text: "Sign in to continue. Dashboard Projects Settings",
    selectors: ["main", "[data-testid=\"user-menu\"]"],
    storageKeys: [],
  });

  assert.equal(result.status, "unknown");
});

test("returns not_required for meaningful public content without auth signals", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "public_example",
    url: "https://public.example/pricing",
    title: "Pricing",
    text: "Pricing Plans Compare features for teams and individuals. Start with the free plan and read product documentation, customer stories, and support articles.",
    selectors: [],
    storageKeys: [],
  });

  assert.equal(result.status, "not_required");
  assert.equal(result.reason, "public content does not require auth");
});

test("returns unknown for empty pages without auth signals", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "public_example",
    url: "https://public.example/blank",
    title: "",
    text: "",
    selectors: [],
    storageKeys: [],
  });

  assert.equal(result.status, "unknown");
});

test("returns unknown for empty pages with only generic storage keys", () => {
  const result = analyzeAuthSnapshot({
    url: "https://example.com",
    title: "",
    text: "",
    selectors: [],
    storageKeys: ["theme"],
  });

  assert.equal(result.status, "unknown");
});

test("requires navigation when explicit auth target host differs from current page", () => {
  assert.equal(shouldNavigateForAuthTarget({
    currentUrl: "https://accounts.example/login",
    targetUrl: "https://app.example/dashboard",
    targetProvided: true,
  }), true);
  assert.equal(shouldNavigateForAuthTarget({
    currentUrl: "https://app.example/settings?tab=profile",
    targetUrl: "https://app.example/dashboard",
    targetProvided: true,
  }), false);
  assert.equal(shouldNavigateForAuthTarget({
    currentUrl: "https://accounts.example/login",
    targetUrl: "https://app.example/dashboard",
    targetProvided: false,
  }), false);
  assert.equal(shouldNavigateForAuthTarget({
    currentUrl: "file:///tmp/blank.html",
    targetUrl: "https://app.example/dashboard",
    targetProvided: true,
  }), true);
});

test("sanitizes verified url before returning auth state", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "secure_example",
    url: "https://secure.example/callback?code=abc&state=xyz#token=secret",
    title: "Dashboard",
    text: "Profile",
    selectors: ["[data-testid=\"user-menu\"]"],
    storageKeys: [],
  });

  assert.equal(result.verified_url, "https://secure.example/callback");
  assert.equal(result.verified_url.includes("code="), false);
  assert.equal(result.verified_url.includes("state="), false);
  assert.equal(result.verified_url.includes("token="), false);
  assert.equal(result.verified_url.includes("#"), false);
});

test("sanitizes url credentials before returning auth state", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "secure_example",
    url: "https://user:password-token@secure.example/callback?code=abc#access_token=secret",
    title: "Dashboard",
    text: "Profile",
    selectors: ["[data-testid=\"user-menu\"]"],
    storageKeys: [],
  });

  assert.equal(result.verified_url, "https://secure.example/callback");
  assert.equal(result.verified_url.includes("user"), false);
  assert.equal(result.verified_url.includes("password-token"), false);
  assert.equal(result.verified_url.includes("code"), false);
  assert.equal(result.verified_url.includes("access_token"), false);
  assert.equal(result.verified_url.includes("@"), false);
  assert.equal(result.verified_url.includes("?"), false);
  assert.equal(result.verified_url.includes("#"), false);
});

test("sanitizes malformed url credentials before returning auth state", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "secure_example",
    url: "https://user:secret@bad host/path?token=secret#hash",
    title: "Dashboard",
    text: "Profile",
    selectors: ["[data-testid=\"user-menu\"]"],
    storageKeys: [],
  });

  assert.equal(result.verified_url.includes("user"), false);
  assert.equal(result.verified_url.includes("secret"), false);
  assert.equal(result.verified_url.includes("@"), false);
  assert.equal(result.verified_url.includes("?"), false);
  assert.equal(result.verified_url.includes("#"), false);
});

test("sanitizes malformed url credentials containing whitespace", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "secure_example",
    url: "https://alice:secret token@bad host/path?code=abc#hash",
    title: "Dashboard",
    text: "Profile",
    selectors: ["[data-testid=\"user-menu\"]"],
    storageKeys: [],
  });

  assert.equal(result.verified_url.includes("alice"), false);
  assert.equal(result.verified_url.includes("secret"), false);
  assert.equal(result.verified_url.includes("@"), false);
  assert.equal(result.verified_url.includes("?"), false);
  assert.equal(result.verified_url.includes("#"), false);
});

test("does not classify generic product text as auth ready", () => {
  const result = analyzeAuthSnapshot({
    profileId: "default",
    systemKey: "secure_example",
    url: "https://secure.example/products",
    title: "Projects Dashboard Settings",
    text: "Projects Dashboard Settings",
    selectors: [],
    storageKeys: [],
  });

  assert.equal(result.status, "unknown");
});

test("does not classify user text alone as auth ready", () => {
  const result = analyzeAuthSnapshot({
    url: "https://public.example/profile",
    title: "Profile",
    text: "Account",
    selectors: [],
    storageKeys: [],
  });

  assert.equal(result.status, "unknown");
});

test("redacts raw storage key names from storage signal details", () => {
  const signals = sanitizeStorageSignals({
    session_token_user_123: true,
  });

  assert.equal(signals.length, 1);
  assert.notEqual(signals[0].detail, "session_token_user_123");
  assert.equal(/session|token|user|123/.test(signals[0].detail), false);
});
