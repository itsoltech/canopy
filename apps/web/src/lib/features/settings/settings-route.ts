import type { page, ReadonlyURL } from "$app/state";
import { getContext, setContext } from "svelte";
import { settingsSectionEnabled } from "@canopy/ui/settings";

/**
 * The settings page being shown, whichever way it is shown: as its own route (a direct load, before
 * the overlay takes over) or as an overlay over another page (shallow routing). Over another page
 * `page.url`, `page.params` and `page.form` belong to the page underneath, so settings pages read their
 * URL, parameters and form result from here (`useSettingsRoute`), never from `$app/state`.
 */
/** What a settings page's loads returned (layouts included), as SvelteKit passes it to the page. */
export type SettingsData = (typeof page)["data"];

/** A form action's result (SvelteKit's `form`): whatever the page's actions returned. */
export type SettingsForm = (typeof page)["form"];

export interface SettingsRoute<Form = SettingsForm> {
  readonly url: ReadonlyURL;
  readonly params: Readonly<Record<string, string>>;
  /** The last form action result of this settings page (SvelteKit's `form`). */
  readonly form: Form;
  /** Removes a one-shot query parameter once the overlay is open, without adding a history entry. */
  consumeQuery(name: string): Promise<boolean>;
  /** Changes the visible topic in the current Settings history entry. */
  selectTopic(hash: string): Promise<void>;
  /** Returns to the page underneath the Settings overlay. */
  close(): void;
  /**
   * Reruns the page's loads that depend on `dependency` (`depends("app:…")`). Use it instead of
   * `invalidate`: over another page that would rerun the page underneath and leave this one stale.
   */
  refresh(dependency: string): Promise<void>;
}

const KEY = Symbol("settings-route");
export const provideSettingsRoute = (route: SettingsRoute) => setContext(KEY, route);

/** `Form`: the page's `PageProps["form"]` (its actions' results). */
export const useSettingsRoute = <Form = SettingsForm>() => getContext<SettingsRoute<Form>>(KEY);

/** A route under Settings (`/settings` itself redirects to its first section). */
export const isSettingsRoute = (id: string | null | undefined): boolean =>
  id === "/settings" || Boolean(id?.startsWith("/settings/"));

const movedTopics = new Map([
  ["/settings/general#topic-thread-list", "/settings/threads#topic-thread-list"],
  ["/settings/general#topic-notifications", "/settings/notifications"],
  ["/settings/workers#topic-updates", "/settings/app-updates#topic-status"],
  ["/settings/app-updates#topic-computers", "/settings/app-updates#topic-status"],
]);

/** Resolve bookmarked topics and disabled modules for both direct loads and links into the overlay. */
export function settingsRedirect(url: ReadonlyURL, modules: readonly string[]): string | undefined {
  const moved = movedTopics.get(url.pathname + url.hash);

  if (moved) {
    const target = new URL(moved, url.href);
    target.search = url.search;

    return settingsSectionEnabled(target.pathname, modules) ? target.href : "/settings/general";
  }

  if (!settingsSectionEnabled(url.pathname, modules)) return "/settings/general";
}

/** What identifies a settings page shown in the overlay: its path and query. */
export const overlayKey = (url: { readonly pathname: string; readonly search: string } | string): string => {
  const { pathname, search } = url instanceof Object ? url : new URL(url, "http://local");

  return pathname + search;
};

/** The `+page.svelte` module of a route id, as `import.meta.glob` names it. */
export const pageModule = (routeId: string): string => `/src/routes${routeId}/+page.svelte`;
