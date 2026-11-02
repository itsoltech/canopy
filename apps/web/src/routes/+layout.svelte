<script lang="ts">
  import "./layout.css";
  import favicon from "#lib/assets/favicon.svg";
  import { ui } from "@open-agents/contracts";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { untrack } from "svelte";
  import AppSidebar from "#lib/features/navigation/AppSidebar.svelte";
  import { applyAppearance } from "#lib/features/settings/appearance.ts";
  import { SettingsState, provideSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { isSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import SettingsOverlay from "#lib/features/settings/SettingsOverlay.svelte";
  import { sectionMemory } from "#lib/features/navigation/sections.svelte.ts";
  import { provideShell } from "#lib/features/navigation/shell.ts";
  import SidebarColumn from "#lib/features/navigation/SidebarColumn.svelte";
  import { SIDEBAR_HOTKEY, SidebarLayout } from "#lib/features/navigation/sidebar-layout.svelte.ts";
  import { OverviewState, provideOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { ModelCatalogState, provideModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Drawer from "#lib/shared/ui/Drawer.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import { hotkeys } from "#lib/shared/ui/hotkeys.ts";
  import Toaster from "#lib/shared/ui/Toaster.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  // One live overview per tab: seeded once from the server load, then kept current by SSE.
  const initial = untrack(() => data);
  const overview = new OverviewState(
    initial.overview ? decode(ui.GetOverviewResponseSchema, initial.overview) : undefined,
    initial.threads ? decode(ui.ListThreadsResponseSchema, initial.threads).threads : [],
  );
  provideOverview(overview);
  $effect(() => overview.connect());

  // Settings live in the gateway: seeded by the server, changed from other devices through the stream.
  const settings = new SettingsState(initial.settings ? decode(ui.GetSettingsResponseSchema, initial.settings) : undefined);
  provideSettings(settings);
  $effect(() => overview.subscribe((update) => settings.apply(update)));
  $effect(() => {
    // After a gap in the stream the settings may have changed meanwhile.
    if (overview.resyncs > 0) void settings.reload().catch(() => undefined);
  });
  // Model catalogs: new ones arrive through the stream; after a gap they reload.
  const models = new ModelCatalogState(initial.models ? decode(ui.ListModelsResponseSchema, initial.models) : undefined);
  provideModelCatalog(models);
  $effect(() => overview.subscribe((update) => models.apply(update)));
  $effect(() => {
    if (overview.resyncs > 0) void models.reload().catch(() => undefined);
  });
  // The server rendered the appearance into <html>; keep it current (and follow the system for "system").
  $effect(() => applyAppearance(settings.appearance));
  $effect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyAppearance(settings.appearance);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  });

  // Desktop sidebar: width and collapse from the appearance settings, rendered by the server (no jump).
  const sidebar = new SidebarLayout(settings);
  $effect(() => () => sidebar.flush());

  let menuOpen = $state(false);
  provideShell({ openMenu: () => (menuOpen = true), sidebar });
  // Close the menu as a navigation starts: Settings then opens over the page (focus returns to the menu button).
  beforeNavigate(() => (menuOpen = false));
  afterNavigate(({ to }) => {
    if (to) sectionMemory.visit(to.url);
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>Open Agents</title>
</svelte:head>

<svelte:window bind:innerWidth={sidebar.viewport} />

<div
  class="isolate flex h-dvh bg-white text-zinc-950 dark:bg-black dark:text-white"
  {@attach hotkeys({ [SIDEBAR_HOTKEY]: () => matchMedia("(min-width: 64rem)").matches && !document.querySelector("dialog:modal") && sidebar.toggle() }, { global: true })}
>
  <SidebarColumn {sidebar}>
    <AppSidebar currentThreadId={page.params.threadId} />
  </SidebarColumn>
  <Drawer bind:open={menuOpen} label="Navigation">
    <AppSidebar currentThreadId={page.params.threadId} />
  </Drawer>

  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if overview.connection === "unavailable"}
      <GrowIn><Alert tone="warning" banner>The gateway is not responding. Showing the last known state; retrying automatically.</Alert></GrowIn>
    {/if}
    <main class="min-h-0 flex-1">
      <!-- A settings page loaded on its own shows in the settings dialog, until it goes over the new thread. -->
      {#if !isSettingsRoute(page.route.id) || page.error}{@render children()}{/if}
    </main>
  </div>
</div>
<SettingsOverlay route={children} />
<Toaster />
