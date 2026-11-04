import type { ReadonlyURL } from "$app/state";
import { getContext, setContext } from "svelte";

/**
 * The settings page being shown, whichever way it is shown: as its own route (a direct load, before
 * the overlay takes over) or as an overlay over another page (shallow routing). Over another page
 * `page.url`, `page.params` and `page.form` belong to the page underneath, so settings pages read their
 * URL, parameters and form result from here (`useSettingsRoute`), never from `$app/state`.
 */
export interface SettingsRoute<Form = Record<string, unknown> | null | undefined> {
  readonly url: ReadonlyURL;
  readonly params: Readonly<Record<string, string>>;
  /** The last form action result of this settings page (SvelteKit's `form`). */
  readonly form: Form;
  /**
   * Reruns the page's loads that depend on `dependency` (`depends("app:…")`). Use it instead of
   * `invalidate`: over another page that would rerun the page underneath and leave this one stale.
   */
  refresh(dependency: string): Promise<void>;
}

const KEY = Symbol("settings-route");
export const provideSettingsRoute = (route: SettingsRoute) => setContext(KEY, route);

/** `Form`: the page's `PageProps["form"]` (its actions' results). */
export const useSettingsRoute = <Form = Record<string, unknown> | null | undefined>() =>
  getContext<SettingsRoute<Form>>(KEY);

/** A route under Settings (`/settings` itself redirects to its first section). */
export const isSettingsRoute = (id: string | null | undefined): boolean =>
  id === "/settings" || Boolean(id?.startsWith("/settings/"));

/** What identifies a settings page shown in the overlay: its path and query. */
export const overlayKey = (url: { readonly pathname: string; readonly search: string } | string): string => {
  const { pathname, search } = typeof url === "string" ? new URL(url, "http://local") : url;

  return pathname + search;
};

/** The `+page.svelte` module of a route id, as `import.meta.glob` names it. */
export const pageModule = (routeId: string): string => `/src/routes${routeId}/+page.svelte`;
