<script lang="ts">
  import favicon from "#lib/assets/favicon.svg";
  import { ui } from "@canopy/contracts";
  import { create } from "@bufbuild/protobuf";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import AppSidebar from "#lib/features/navigation/AppSidebar.svelte";
  import { appearanceFromDocument, applyAppearance } from "#lib/features/settings/appearance.ts";
  import { SettingsState, provideSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { isSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import SettingsOverlay from "#lib/features/settings/SettingsOverlay.svelte";
  import { sectionMemory } from "#lib/features/navigation/sections.svelte.ts";
  import { provideShell } from "#lib/features/navigation/shell.ts";
  import SidebarColumn from "#lib/features/navigation/SidebarColumn.svelte";
  import { SidebarLayout } from "#lib/features/navigation/sidebar-layout.svelte.ts";
  import { appCommands } from "#lib/features/commands/app-commands.ts";
  import { PaletteState, providePalette } from "#lib/features/commands/commands.svelte.ts";
  import CommandPalette from "#lib/features/commands/CommandPalette.svelte";
  import { CommandRegistry, provideCommands } from "#lib/features/commands/registry.ts";
  import { OverviewState, provideOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { ModelCatalogState, provideModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Drawer from "#lib/shared/ui/Drawer.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import Toaster from "#lib/shared/ui/Toaster.svelte";
  import BotSettingsHost from "#lib/features/bots/settings/BotSettingsHost.svelte";
  import UpdateBanner from "#lib/shared/ui/UpdateBanner.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import GatewayUnavailable from "#lib/shared/ui/GatewayUnavailable.svelte";
  import type { Snippet } from "svelte";
  import { ThreadActions, provideThreadActions } from "#lib/features/threads/thread-actions.svelte.ts";
  import ThreadActionDialogs from "#lib/features/threads/components/ThreadActionDialogs.svelte";

  let { children }: { children: Snippet } = $props();

  // One overview per tab. Its first SSE connection fetches the current state, then follows changes.
  const overview = new OverviewState(undefined);
  provideOverview(overview);
  $effect(() => overview.connect());
  let ready = $state(false);

  // Settings live in the gateway: seeded by the server, changed from other devices through the stream.
  const settings = new SettingsState(create(ui.GetSettingsResponseSchema, { user: { appearance: appearanceFromDocument() } }));
  provideSettings(settings);
  const threadActions = new ThreadActions(overview, settings, () => page.params.threadId);
  provideThreadActions(threadActions);
  $effect(() => overview.subscribe((update) => settings.apply(update)));
  // Model catalogs: new ones arrive through the stream; after a gap they reload.
  const models = new ModelCatalogState(undefined);
  provideModelCatalog(models);
  $effect(() => overview.subscribe((update) => models.apply(update)));
  $effect(() => {
    if (overview.resyncs > 0) void Promise.allSettled([settings.reload(), models.reload()]).then(() => (ready = true));
  });
  // The server rendered the appearance into <html>; keep it current (and follow the system for "system").
  $effect(() => applyAppearance(settings.appearance));
  onMount(() => document.getElementById("canopy-boot")?.remove());
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
  // One sidebar at a time: the column from `lg` (it is max-lg:hidden), the drawer below. Mounting both made every
  // list in it (threads, archived pages, …) load twice.
  const wide = new MediaQuery("(min-width: 64rem)");
  $effect(() => { if (wide.current) menuOpen = false; });
  provideShell({ openMenu: () => (menuOpen = true), sidebar });
  // Close the menu as a navigation starts: Settings then opens over the page (focus returns to the menu button).
  beforeNavigate(() => (menuOpen = false));

  // Command palette (Mod+K): the app's commands here, pages add their own (contributeCommands).
  const commands = new CommandRegistry();
  provideCommands(commands);
  const palette = new PaletteState();
  providePalette(palette);
  commands.add(
    appCommands({
      overview,
      settings,
      sidebar,
      threadActions,
      openMenu: () => (menuOpen = true),
      currentThreadId: () => page.params.threadId,
      currentProjectId: () =>
        (page.params.threadId ? overview.threads.get(page.params.threadId)?.projectId : undefined) ??
        page.params.projectId ??
        (page.url.pathname === "/" ? page.url.searchParams.get("project") : undefined) ??
        undefined,
    }),
  );
  afterNavigate(({ to }) => {
    if (to) sectionMemory.visit(to.url);
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>Canopy</title>
</svelte:head>

<svelte:window bind:innerWidth={sidebar.viewport} />
<ThreadActionDialogs />

<div class="isolate flex h-dvh bg-white text-zinc-950 dark:bg-black dark:text-white">
  <SidebarColumn {sidebar}>
    {#if wide.current}<AppSidebar currentThreadId={page.params.threadId} />{/if}
  </SidebarColumn>
  <Drawer bind:open={menuOpen} label="Navigation">
    {#if !wide.current}<AppSidebar currentThreadId={page.params.threadId} />{/if}
  </Drawer>

  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if overview.connection === "unavailable"}
      <GrowIn><Alert tone="warning" banner>The gateway is not responding. Showing the last known state; retrying automatically.</Alert></GrowIn>
    {/if}
    <main class="min-h-0 flex-1">
      <!-- A settings page loaded on its own shows in the settings dialog, until it goes over the new thread. -->
      {#if overview.resyncs === 0 && overview.connection === "unavailable" && !page.error}
        <GatewayUnavailable retry={() => location.reload()} />
      {:else if !ready && !page.error}
        <div class="flex h-full flex-col gap-4 p-6" role="status" aria-label="Loading application">
          <Skeleton class="h-6 w-44" />
          <div class="m-auto flex w-full max-w-(--chat-width) flex-col gap-4"><Skeleton class="h-8 w-64" /><Skeleton class="h-32 w-full" /></div>
        </div>
      {:else if !isSettingsRoute(page.route.id) || page.error}{@render children()}{/if}
    </main>
  </div>
</div>
{#if ready}<SettingsOverlay route={children} />{/if}
<CommandPalette registry={commands} {palette} />
<Toaster />
<BotSettingsHost />
<UpdateBanner />
