/** Project logins: credentials Agent Browser enters on matching websites (docs/secrets.md#loginy-projektu). */

export const PROJECT_LOGINS = "project_logins_v1";
export const LOGIN_WEBSITES_MAX = 20;
export const LOGIN_NOTES_MAX = 2000;
export const LOGIN_USERNAME_MAX = 4096;
export const LOGIN_PASSWORD_MAX = 8192;

/** A website is an origin: scheme, a host of up to 253 characters and a port. */
export const LOGIN_WEBSITE_MAX = 300;
export const LOGIN_NAME_MAX = 128;

/** The largest field Browser Preview can enter: a password of LOGIN_PASSWORD_MAX characters in UTF-8. */
export const LOGIN_PREVIEW_TEXT_MAX_BYTES = LOGIN_PASSWORD_MAX * 4;

/** Metadata the owner and the thread's agent may read. It never holds the password or the setup key. */
export interface ProjectLoginMetadata {
  websites: string[];
  username: string;
  show_username: boolean;
  notes: string;
  ask_each_time: boolean;
  outside_browser: boolean;
  one_time_code: boolean;
}

/** The encrypted part of a login. */
export interface ProjectLoginSecret {
  password: string;
  one_time_code_setup?: string;
}

/** What a worker receives for one browser fill, kept in its memory. */
export interface ProjectLoginValue {
  name: string;
  username: string;
  password: string;
  one_time_code_setup?: string;
  websites: string[];
  hide_username: boolean;
}

const WILDCARD = "*.";

/**
 * A website is an origin (scheme, host and port). A leading `*.` in the host matches its subdomains, not the
 * domain itself. Returns undefined for anything else.
 */
export function normalizeLoginWebsite(input: string): string | undefined {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const schemeEnd = withScheme.indexOf("://") + 3;
  const wildcard = withScheme.slice(schemeEnd).startsWith(WILDCARD);
  const parsed = URL.parse(wildcard ? withScheme.replace(WILDCARD, "wildcard-host.") : withScheme);

  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return;

  // A pasted page address keeps only its origin.
  const host = wildcard ? parsed.host.replace(/^wildcard-host\./, WILDCARD) : parsed.host;

  if (!host || host === WILDCARD || (wildcard && !host.slice(WILDCARD.length).includes("."))) return;

  return `${parsed.protocol}//${host}`;
}

/** Whether a page origin is one of a login's websites. */
export function loginWebsiteMatches(website: string, origin: string): boolean {
  const page = URL.parse(origin);

  if (!page || page.origin !== origin) return false;

  if (!website.includes(`//${WILDCARD}`)) return website === origin;
  const [scheme, pattern = ""] = website.split(`//${WILDCARD}`);

  return `${page.protocol}` === scheme && page.host.endsWith(`.${pattern}`);
}

export function loginAllowsOrigin(websites: readonly string[], origin: string): boolean {
  return websites.some((website) => loginWebsiteMatches(website, origin));
}

export function parseLoginWebsites(inputs: readonly string[]): string[] | undefined {
  const websites = inputs.map(normalizeLoginWebsite);

  if (
    !websites.length ||
    websites.length > LOGIN_WEBSITES_MAX ||
    websites.some((website) => !website || website.length > LOGIN_WEBSITE_MAX)
  )
    return;

  return [...new Set(websites.filter((website): website is string => Boolean(website)))];
}
