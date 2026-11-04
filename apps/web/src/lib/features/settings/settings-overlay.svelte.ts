import type { Component } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { goto, preloadData } from "$app/navigation";
import { match } from "$app/paths";
import { page } from "$app/state";
import { isSettingsRoute, overlayKey, pageModule } from "./settings-route.ts";

/** Every settings page, loaded on demand: any route under `/settings` works in the overlay as it is. */
type SettingsPage = Component<{ data: Record<string, unknown>; form: Record<string, unknown> | null | undefined }>;

const modules = import.meta.glob<{ default: SettingsPage }>("/src/routes/settings/**/+page.svelte");

export type OverlayPage =
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly component: SettingsPage;
      /** What the route's loads returned (layouts included), as SvelteKit passes it to the page. */
      readonly data: Record<string, unknown>;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly status: "error"; readonly code: number; readonly message: string };

type Loaded = OverlayPage | { readonly redirect: string };

/**
 * Settings as an overlay over whatever page is open (SvelteKit shallow routing): opening one adds a
 * history entry with the settings URL and `page.shallow`, without navigating, so the page underneath
 * stays mounted as it was. The settings page's data comes from `preloadData`, its component from the
 * route's own `+page.svelte`. Moving between settings pages replaces that entry: Back (and Escape)
 * leave Settings in one step, whatever was visited inside.
 */
class SettingsOverlay {
  /** Settings pages loaded for the overlay, by `overlayKey`. */
  readonly pages = new SvelteMap<string, OverlayPage>();
  /**
   * A direct load handing over to the overlay: the page shown meanwhile (`handOver`); `ready` once the
   * page underneath is in place (before that the dialog shows the route's own content).
   */
  bridging = $state<{ readonly key: string; readonly ready: boolean }>();
  /** The title of the page underneath: settings pages set their own, closing puts it back. */
  pageTitle: string | undefined;
  #token = 0;
  #handingOver = false;

  /** Opens `href` over the current page (`replace`: instead of the settings page already open). */
  async open(href: string, replace: boolean): Promise<void> {
    const token = ++this.#token;
    let key = overlayKey(href);

    for (let hops = 0; ; hops++) {
      const loaded = await this.#load(key);

      if (token !== this.#token) return;

      if (!("redirect" in loaded)) {
        this.pages.set(key, loaded);
        break;
      }

      // `/settings` goes on to its first section; a redirect out of Settings is a real navigation.
      const next = overlayKey(loaded.redirect);

      if (hops >= 3 || !isSettingsRoute((await match(next))?.id)) return goto(loaded.redirect);
      key = next;
    }

    const over = replace ? page.state.settingsOver : overlayKey(page.url);
    await goto(key, {
      shallow: true,
      replace,
      state: { settingsOver: over ?? overlayKey(page.url) },
      persistState: true,
    });
  }

  /** Loads a page the overlay shows but has not loaded (Forward into Settings, a hand-over). */
  async ensure(key: string): Promise<void> {
    if (this.pages.has(key)) return;
    this.pages.set(key, { status: "loading" });
    await this.reload(key);
  }

  /** Loads the page again (after its data changed); the old one stays on screen meanwhile. */
  async reload(key: string): Promise<void> {
    const loaded = await this.#load(key);

    if ("redirect" in loaded) {
      this.pages.delete(key);

      if ((page.shallow ? overlayKey(page.shallow.url) : "") === key) await this.open(loaded.redirect, true);

      return;
    }

    this.pages.set(key, loaded);
  }

  /**
   * A settings page loaded on its own (a new tab, a reload) goes over the page it was opened from (kept
   * in `page.state` across reloads) or else the new thread: that page replaces the history entry and the
   * settings page is opened over it, so closing it goes there. The dialog stays on screen throughout.
   */
  async handOver(): Promise<void> {
    if (this.#handingOver) return;
    this.#handingOver = true;
    const key = overlayKey(page.url);
    const routeId = page.route.id;
    const saved = page.state.settingsOver;
    const over = saved && !isSettingsRoute((await match(saved))?.id) ? saved : "/";

    try {
      const load = routeId ? modules[pageModule(routeId)] : undefined;

      if (load)
        this.pages.set(key, {
          status: "loaded",
          component: (await load()).default,
          data: page.data,
          params: { ...page.params },
        });
      this.bridging = { key, ready: false };
      await goto(over, { replace: true, reset: false });
      // The page underneath has set its title; the settings page mounts again after it, with its own.
      this.pageTitle = document.title;
      this.bridging = { key, ready: true };
      await goto(key, { shallow: true, state: { settingsOver: over }, persistState: true });
    } finally {
      this.bridging = undefined;
      this.#handingOver = false;
    }
  }

  async #load(key: string): Promise<Loaded> {
    const route = await match(key);
    const result = await preloadData(key);

    if (result.type === "redirect") return { redirect: result.location };

    if (result.type === "error") return { status: "error", code: result.status, message: result.error.message };
    const load = route ? modules[pageModule(route.id)] : undefined;

    if (!route || !load) return { status: "error", code: 404, message: "Not found" };

    return { status: "loaded", component: (await load()).default, data: result.data, params: route.params };
  }
}

export const settingsOverlay = new SettingsOverlay();
