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

// One star at the end of the first label, followed by a fixed domain.
const WILDCARD_HOST = /^([a-z0-9_-]*)\*((?:\.[a-z0-9_-]+){2,}\.?)$/;

/**
 * A pasted URL keeps only its origin. The host may start with a wildcard such as *.example.com
 * or pr-*.app.example.com.
 */
export function normalizeLoginWebsite(input: string): string | undefined {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = URL.parse(withScheme);

  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return;

  if (parsed.hostname.includes("*") && !WILDCARD_HOST.test(parsed.hostname)) return;

  return parsed.origin;
}

/** Whether a page origin is one of a login's websites. */
export function loginWebsiteMatches(website: string, origin: string): boolean {
  const page = URL.parse(origin);

  if (!page || page.origin !== origin || page.hostname.includes("*")) return false;

  if (!website.includes("*")) return website === origin;
  const site = URL.parse(website);

  if (!site || site.origin !== website || site.protocol !== page.protocol || site.port !== page.port) return false;
  const [, prefix, suffix] = WILDCARD_HOST.exec(site.hostname) ?? [];

  if (!suffix || !page.hostname.endsWith(suffix)) return false;
  const subdomain = page.hostname.slice(0, -suffix.length);

  // A whole-label wildcard covers nested subdomains. A prefix wildcard stays inside one label.
  if (!prefix) return subdomain.length > 0;

  return subdomain.startsWith(prefix) && /^[a-z0-9_-]+$/.test(subdomain.slice(prefix.length));
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
