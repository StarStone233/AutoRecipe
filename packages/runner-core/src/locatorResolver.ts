import type { RunnerLocator } from "./schema.js";
import type { PageLike, PageLocatorLike } from "./pageTypes.js";

const LOCATOR_ORDER: RunnerLocator["strategy"][] = ["css", "role", "label", "text", "visual", "coordinate"];

export async function resolveLocator(page: PageLike, locators: RunnerLocator[]): Promise<PageLocatorLike> {
  const sorted = [...locators].sort((left, right) => LOCATOR_ORDER.indexOf(left.strategy) - LOCATOR_ORDER.indexOf(right.strategy));
  for (const locator of sorted) {
    const resolved = resolveSingleLocator(page, locator);
    if (resolved) return resolved;
  }
  throw new Error("No supported locator available for step");
}

function resolveSingleLocator(page: PageLike, locator: RunnerLocator): PageLocatorLike | undefined {
  if (locator.strategy === "css" && locator.selector && page.locator) {
    return page.locator(locator.selector);
  }
  if (locator.strategy === "role" && locator.role && page.getByRole) {
    return page.getByRole(locator.role, { name: locator.name, exact: locator.exact });
  }
  if (locator.strategy === "label" && locator.text && page.getByLabel) {
    return page.getByLabel(locator.text, { exact: locator.exact });
  }
  if (locator.strategy === "text" && locator.text && page.getByText) {
    return page.getByText(locator.text, { exact: locator.exact });
  }
  return undefined;
}
