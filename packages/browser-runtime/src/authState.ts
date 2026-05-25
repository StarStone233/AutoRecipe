import {
  AuthSignal,
  AuthStatus,
  AuthVerification,
  AuthVerificationSchema,
} from "@autorecipe/knowledge-core";

export type AuthSnapshot = {
  profileId?: string;
  systemKey?: string;
  url: string;
  title?: string;
  text?: string;
  selectors?: string[];
  storageKeys?: string[];
};

const LOGIN_URL_PATTERN = /(?:^|[/?#&])(login|log-in|signin|sign-in|auth|sso|passport)(?:[/?#=&-]|$)/i;
const LOGIN_TEXT_PATTERN = /\b(sign in|sign-in|log in|log-in|login|password|captcha|verification code)\b|登录|登入|密码|验证码/i;
const USER_TEXT_PATTERN = /\b(log out|logout|profile|account)\b|退出|账户|账号|个人中心/i;
const SENSITIVE_STORAGE_KEY_PATTERN = /token|session|auth|sid|jwt|credential|secret|user|account|email/i;
const MAIN_SELECTORS = new Set([
  "main",
  "[role=\"main\"]",
  "#app",
  "#root",
  "[data-app-shell]",
  "[data-testid=\"app-shell\"]",
]);
const USER_SELECTORS = new Set([
  "[data-testid=\"user-menu\"]",
  "[aria-label=\"user menu\"]",
  "[data-user-menu]",
  ".user-menu",
  "#user-menu",
]);
const NAVIGATION_SELECTORS = new Set([
  "nav",
  "[role=\"navigation\"]",
  "[data-testid=\"navigation\"]",
  "[aria-label=\"primary navigation\"]",
]);

export function analyzeAuthSnapshot(snapshot: AuthSnapshot): AuthVerification {
  const url = String(snapshot.url || "");
  const verifiedUrl = sanitizeVerifiedUrl(url);
  const text = compact(`${snapshot.title || ""} ${snapshot.text || ""}`, 4000);
  const normalizedText = text.toLowerCase();
  const selectors = new Set((snapshot.selectors || []).map((item) => item.toLowerCase()));
  const signals: AuthSignal[] = [];

  const loginUrl = LOGIN_URL_PATTERN.test(url);
  signals.push({
    kind: "url",
    name: "login_url",
    matched: loginUrl,
    confidence: loginUrl ? 0.9 : 0.45,
    detail: loginUrl ? "login-like URL" : "non-login URL",
  });

  const loginText = LOGIN_TEXT_PATTERN.test(normalizedText);
  signals.push({
    kind: "text",
    name: "login_text",
    matched: loginText,
    confidence: loginText ? 0.78 : 0.45,
    detail: loginText ? "login-like text" : "no login text",
  });

  const mainShell = hasAny(selectors, MAIN_SELECTORS);
  signals.push({
    kind: "selector",
    name: "main_shell",
    matched: mainShell,
    confidence: mainShell ? 0.72 : 0.35,
    detail: mainShell ? "main application shell selector detected" : "main shell selector missing",
  });

  const userSelector = hasAny(selectors, USER_SELECTORS);
  signals.push({
    kind: "selector",
    name: "user_selector",
    matched: userSelector,
    confidence: userSelector ? 0.88 : 0.35,
    detail: userSelector ? "user selector detected" : "user selector missing",
  });

  const navigationSelector = hasAny(selectors, NAVIGATION_SELECTORS);
  signals.push({
    kind: "selector",
    name: "navigation_shell",
    matched: navigationSelector,
    confidence: navigationSelector ? 0.68 : 0.35,
    detail: navigationSelector ? "navigation selector detected" : "navigation selector missing",
  });

  const userText = USER_TEXT_PATTERN.test(normalizedText);
  signals.push({
    kind: "text",
    name: "user_text",
    matched: userText,
    confidence: userText ? 0.7 : 0.35,
    detail: userText ? "authenticated UI text detected" : "authenticated UI text missing",
  });

  const storageSignals = sanitizeStorageSignals(Object.fromEntries((snapshot.storageKeys || []).map((key) => [key, true])));
  signals.push(...storageSignals);

  const hasLoginSignal = loginUrl || loginText;
  const hasAppUiSignal = mainShell || userSelector || navigationSelector;
  const hasSensitiveStorageSignal = storageSignals.some((signal) => signal.detail === "storage:sensitive");
  const hasAppSignal = hasAppUiSignal || hasSensitiveStorageSignal;
  const hasPublicContent = isMeaningfulPublicContent(text);
  const status: AuthStatus = hasLoginSignal && !hasAppUiSignal
    ? "required"
    : hasAppSignal && !hasLoginSignal
      ? "ready"
      : !hasLoginSignal && !hasAppSignal && hasPublicContent
        ? "not_required"
        : "unknown";

  return AuthVerificationSchema.parse({
    profile_id: snapshot.profileId || "default",
    system_key: snapshot.systemKey || "default",
    status,
    verified_at: new Date().toISOString(),
    verified_url: verifiedUrl,
    reason: reasonForStatus(status),
    signals,
    sensitive_values_stored: false,
  });
}

export function sanitizeStorageSignals(values: Record<string, unknown>): AuthSignal[] {
  return Object.keys(values).sort().map((key) => ({
    kind: "storage",
    name: "storage_key",
    matched: true,
    confidence: SENSITIVE_STORAGE_KEY_PATTERN.test(key) ? 0.7 : 0.35,
    detail: SENSITIVE_STORAGE_KEY_PATTERN.test(key) ? "storage:sensitive" : "storage:general",
  }));
}

export function shouldNavigateForAuthTarget(input: {
  currentUrl: string;
  targetUrl: string;
  targetProvided: boolean;
}): boolean {
  if (!input.targetProvided) return false;
  const currentHost = urlHost(input.currentUrl);
  const targetHost = urlHost(input.targetUrl);
  return Boolean(targetHost && currentHost !== targetHost);
}

function hasAny(actual: Set<string>, expected: Set<string>): boolean {
  for (const item of expected) {
    if (actual.has(item)) return true;
  }
  return false;
}

function urlHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function compact(value: string, max: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function isMeaningfulPublicContent(text: string): boolean {
  if (text.length < 80) return false;
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  return words.length >= 12;
}

function sanitizeVerifiedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const withoutQueryOrHash = value.split(/[?#]/, 1)[0] || "";
    return sanitizeMalformedUrlUserinfo(withoutQueryOrHash);
  }
}

function sanitizeMalformedUrlUserinfo(value: string): string {
  const authorityStart = value.indexOf("//");
  if (authorityStart === -1) return value.includes("@") ? "" : value;

  const authorityOffset = authorityStart + 2;
  const pathStart = value.indexOf("/", authorityOffset);
  const authorityEnd = pathStart === -1 ? value.length : pathStart;
  const authority = value.slice(authorityOffset, authorityEnd);
  const userinfoEnd = authority.lastIndexOf("@");
  if (userinfoEnd === -1) return value;

  return `${value.slice(0, authorityOffset)}${authority.slice(userinfoEnd + 1)}${value.slice(authorityEnd)}`;
}

function reasonForStatus(status: AuthStatus): string {
  if (status === "ready") return "auth signals indicate application shell";
  if (status === "required") return "login page detected";
  if (status === "not_required") return "public content does not require auth";
  return "auth state could not be verified";
}
