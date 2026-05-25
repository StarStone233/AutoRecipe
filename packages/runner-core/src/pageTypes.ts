export type PageLocatorLike = {
  fill?: (value: string, options?: { timeout?: number }) => Promise<void>;
  click?: (options?: { timeout?: number }) => Promise<void>;
  press?: (key: string, options?: { timeout?: number }) => Promise<void>;
  isVisible?: (options?: { timeout?: number }) => Promise<boolean>;
};

export type PageLike = {
  goto?: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  locator?: (selector: string) => PageLocatorLike;
  getByRole?: (role: string, options?: { name?: string | RegExp; exact?: boolean }) => PageLocatorLike;
  getByLabel?: (text: string | RegExp, options?: { exact?: boolean }) => PageLocatorLike;
  getByText?: (text: string | RegExp, options?: { exact?: boolean }) => PageLocatorLike;
  waitForURL?: (url: string | RegExp, options?: { timeout?: number }) => Promise<unknown>;
  url?: () => string;
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
  off?: (event: string, handler: (...args: unknown[]) => void) => unknown;
};
