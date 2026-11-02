<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { beforeNavigate, invalidate } from "$app/navigation";
  import { page, updated } from "$app/state";
  import { updateState } from "#lib/shared/updates.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { settingsOverlay as overlay } from "./settings-overlay.svelte.ts";
  import { isSettingsRoute, overlayKey, provideSettingsRoute, type SettingsRoute } from "./settings-route.ts";
  import SettingsDialog from "./SettingsDialog.svelte";

  /**
   * Shows Settings over the app (docs/ui-api.md §4). Any link or `goto` to a page under `/settings`
   * opens it here as an overlay (`settings-overlay.svelte.ts`) instead of navigating: the page
   * underneath stays mounted, untouched. A settings page loaded on its own (`route`: the route's
   * content) shows in the same dialog until it hands over to the overlay.
   */
  let { route }: { route: Snippet } = $props();

  const routeMode = $derived(isSettingsRoute(page.route.id) && !page.error);
  const shallowKey = $derived(!routeMode && page.shallow?.route && isSettingsRoute(page.shallow.route.id) ? overlayKey(page.shallow.url) : undefined);
  const key = $derived(routeMode ? undefined : (shallowKey ?? overlay.bridging?.key));

  type View = { key?: string | undefined; url: SettingsRoute["url"]; params: Readonly<Record<string, string>> };
  const view = $derived.by((): View | undefined => {
    if (routeMode) return { url: page.url, params: page.params };
    if (!key) return undefined;
    const entry = overlay.pages.get(key);
    return { key, url: new URL(key, page.url.origin), params: entry?.status === "loaded" ? entry.params : {} };
  });

  // What the dialog shows: the current view, or the last one while it plays its exit.
  let last = $state.raw<View>();
  $effect(() => {
    if (view) last = view;
  });
  const shown = $derived(view ?? last);
  const open = $derived(Boolean(view));
  const entry = $derived(shown?.key ? overlay.pages.get(shown.key) : undefined);

  // Settings pages set the document title (and nothing sets it back): keep the page's own while closed.
  $effect(() => {
    const record = () => !untrack(() => view) && (overlay.pageTitle = document.title);
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  });
  $effect(() => {
    if (!view && overlay.pageTitle !== undefined) document.title = overlay.pageTitle;
  });

  $effect(() => {
    if (key && !overlay.pages.has(key)) untrack(() => void overlay.ensure(key));
  });
  $effect(() => {
    if (routeMode) untrack(() => void overlay.handOver());
  });

  // The form action result of the settings page (`page.form` is the page's, underneath, too).
  let form = $state.raw<Record<string, unknown> | null>(null);
  $effect(() => {
    const result = page.form as Record<string, unknown> | null;
    untrack(() => (form = result));
  });
  $effect(() => {
    void key;
    form = null;
  });

  // Data reloaded underneath (a form action's refresh, an invalidation): the settings page's too.
  let seen = page.data;
  $effect(() => {
    const data = page.data;
    if (data === seen) return;
    seen = data;
    untrack(() => shallowKey && void overlay.reload(shallowKey));
  });

  provideSettingsRoute({
    get url() {
      return shown?.url ?? page.url;
    },
    get params() {
      return shown?.params ?? page.params;
    },
    get form() {
      return routeMode ? page.form : form;
    },
    async refresh(dependency) {
      // Keeps `page.state`; also drops the preloaded data, so the reload below fetches anew.
      await invalidate(dependency, true);
      if (shallowKey) await overlay.reload(shallowKey);
    },
  });

  beforeNavigate((navigation) => {
    if (updated.current || updateState.available) return;
    const to = navigation.to;
    if (navigation.shallow || routeMode || (navigation.type !== "link" && navigation.type !== "goto")) return;
    if (!to?.route.id || !isSettingsRoute(to.route.id)) return;
    navigation.cancel();
    void overlay.open(to.url.href, Boolean(shallowKey));
  });

  $effect(() => {
    if (!key || entry?.status !== "error" || entry.code < 500) return;
    const target = key;
    const timer = setInterval(() => {
      if (!document.hidden && navigator.onLine) void overlay.reload(target);
    }, 3000);
    return () => clearInterval(timer);
  });

  // The overlay is one history entry over the page: closing is going back to it.
  const close = () => {
    if (routeMode) return;
    history.back();
  };
</script>

{#if shown}
  <SettingsDialog {open} onclose={close} onexited={() => !view && (last = undefined)}>
    {#if !shown.key}
      {@render route()}
    {:else if overlay.bridging?.key === shown.key && !overlay.bridging.ready}
      <!-- Handing over: the route's content just left, the same page mounts once the page underneath is in. -->
    {:else if entry?.status === "loaded"}
      <entry.component data={entry.data} {form} />
    {:else if entry?.status === "error"}
      <Alert tone="error" title={entry.code === 404 ? "Not found" : "This page could not be loaded"}>
        {entry.message}
        {#snippet actions()}<Button size="sm" icon="arrow-path" onclick={() => shown?.key && overlay.reload(shown.key)}>Try again</Button>{/snippet}
      </Alert>
    {:else}
      <p class="flex items-center justify-center gap-2 py-16 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status"><Spinner />Loading…</p>
    {/if}
  </SettingsDialog>
{/if}
