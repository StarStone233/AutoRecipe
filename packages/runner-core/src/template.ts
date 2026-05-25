import type { RunnerParams } from "./schema.js";

const TEMPLATE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function renderTemplate(value: string, params: RunnerParams): string {
  return value.replace(TEMPLATE_PATTERN, (_match, key: string) => {
    const replacement = params[key];
    if (replacement === undefined || replacement === null) {
      throw new Error(`Missing template param: ${key}`);
    }
    return String(replacement);
  });
}
