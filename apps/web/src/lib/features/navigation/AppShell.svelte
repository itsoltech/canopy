<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { ui } from "@canopy/contracts";
  import { create } from "@bufbuild/protobuf";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount, onDestroy } from "svelte";
  import { threadCache } from "#lib/features/threads/thread-cache.ts";
  import { botCache } from "#lib/features/bots/cache.ts";
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
  import AddProjectDialog from "#lib/features/projects/add/AddProjectDialog.svelte";
  import { AddProjectState, provideAddProject } from "#lib/features/projects/add/add-project.svelte.ts";
  import { CommandRegistry, provideCommands } from "#lib/features/commands/registry.ts";
  import { OverviewState, provideOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { ModelCatalogState, provideModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Drawer from "#lib/shared/ui/Drawer.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import Toaster from "#lib/shared/ui/Toaster.svelte";
  import BotSettingsHost from "#lib/features/bots/settings/BotSettingsHost.svelte";
  import BotMoveHost from "#lib/features/bots/components/BotMoveHost.svelte";
  import UpdateBanner from "#lib/shared/ui/UpdateBanner.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import GatewayUnavailable from "#lib/shared/ui/GatewayUnavailable.svelte";
  import type { Snippet } from "svelte";
  import { ThreadActions, provideThreadActions } from "#lib/features/threads/thread-actions.svelte.ts";
  import ThreadActionDialogs from "#lib/features/threads/components/ThreadActionDialogs.svelte";
  import {
    GatewayCapabilities,
    provideGatewayCapabilities,
  } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import GatewayCompatibility from "#lib/features/desktop/GatewayCompatibility.svelte";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { applyDeviceAppearance } from "#lib/features/settings/device-appearance.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import { watchNotifications } from "#lib/features/notifications/watch.svelte.ts";

  let { children }: { children: Snippet } = $props();

  onDestroy(() => {
    threadCache.clear();
    botCache.clear();
  });

  onMount(() => {
    const clear = () => {
      threadCache.clear();
      botCache.clear();
    };

    window.addEventListener("pagehide", clear);

    return () => window.removeEventListener("pagehide", clear);
  });

  const capabilities = new GatewayCapabilities();

  provideGatewayCapabilities(capabilities);

  $effect(() => capabilities.connect());

  // One overview per tab. Its first SSE connection fetches the current state, then follows changes.
  const overview = new OverviewState(undefined);

  provideOverview(overview);

  $effect(() => overview.connect());

  let ready = $state(false);

  // Settings live in the gateway: seeded by the server, changed from other devices through the stream.
  const settings = new SettingsState(
    create(ui.GetSettingsResponseSchema, { user: { appearance: appearanceFromDocument() } }),
  );

  provideSettings(settings);

  onMount(() => devicePreferences.connect());

  $effect(() => {
    if (!settings.loaded) return;
    devicePreferences.initializeView({
      archivedThreadsExpanded: settings.sidebar.archivedExpanded,
      sidebarCollapsed: settings.appearance.sidebarCollapsed,
      sidebarWidth: settings.appearance.sidebarWidth,
      threadPanelCollapsed: settings.appearance.threadPanelCollapsed,
    });
  });

  onMount(() => keybindings.connect());

  $effect(() => applyDeviceAppearance(devicePreferences));

  onMount(() => watchNotifications(overview, () => page.url.pathname));

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
  $effect(() => applyAppearance(settings.appearance, devicePreferences.view));

  onMount(() => document.getElementById("canopy-boot")?.remove());

  $effect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyAppearance(settings.appearance, devicePreferences.view);
    query.addEventListener("change", follow);

    return () => query.removeEventListener("change", follow);
  });

  // Desktop geometry belongs to this browser profile or desktop shell.
  const sidebar = new SidebarLayout();

  $effect(() => () => sidebar.flush());

  let menuOpen = $state(false);

  // One sidebar at a time: the column from `lg` (it is max-lg:hidden), the drawer below. Mounting both made every
  // list in it (threads, archived pages, …) load twice.
  const wide = new MediaQuery("(min-width: 64rem)");

  $effect(() => {
    if (wide.current) menuOpen = false;
  });

  provideShell({ openMenu: () => (menuOpen = true), sidebar });

  // Close the menu as a navigation starts: Settings then opens over the page (focus returns to the menu button).
  beforeNavigate(() => (menuOpen = false));

  // Command palette (Mod+K): the app's commands here, pages add their own (contributeCommands).
  const commands = new CommandRegistry();

  provideCommands(commands);

  const palette = new PaletteState();

  providePalette(palette);

  const addProject = new AddProjectState();

  provideAddProject(addProject);

  commands.add(
    appCommands({
      overview,
      settings,
      sidebar,
      threadActions,
      capabilities,
      addProject,
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
  <title>{applicationName}</title>
</svelte:head>

<svelte:window bind:innerWidth={sidebar.viewport} />
<ThreadActionDialogs />

<!-- `data-sidebar`: whether the sidebar clears the page header from the native window controls. While the column
     eases (`data-sidebar-settling`), the header's clearance eases with it (layout.css), so the toggle never jumps.
     The shell fills the window and clips: only its own panes scroll, so nothing inside (a live region, an easing
     panel) can give the window a page scrollbar. -->
<div
  class="relative isolate flex h-dvh overflow-clip bg-canvas text-ink"
  data-sidebar={wide.current && !sidebar.collapsed ? "shown" : "hidden"}
  data-sidebar-settling={sidebar.settling || undefined}
>
  <SidebarColumn {sidebar}>
    {#if wide.current}<AppSidebar currentThreadId={page.params.threadId} />{/if}
  </SidebarColumn>
  <Drawer bind:open={menuOpen} label="Navigation">
    {#if !wide.current}<AppSidebar currentThreadId={page.params.threadId} />{/if}
  </Drawer>

  <div
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    data-window-offset={overview.connection === "unavailable" || !ready || Boolean(page.error) || undefined}
  >
    {#if overview.connection === "unavailable" || !ready || page.error}
      <!-- Keep banners, loading and error content below a static native title strip. -->
      <div class="hidden h-12 shrink-0 desktop:block" data-window-drag></div>
    {/if}
    {#if overview.connection === "unavailable"}
      <GrowIn
        ><Alert tone="warning" banner
          >The gateway is not responding. Showing the last known state; retrying automatically.</Alert
        ></GrowIn
      >
    {/if}
    <main class="min-h-0 flex-1">
      <!-- A settings page loaded on its own shows in the settings dialog, until it goes over the new thread. -->
      {#if capabilities.incompatible}
        <GatewayCompatibility message={capabilities.message} />
      {:else if !capabilities.supports(page.url.pathname)}
        <GatewayCompatibility message={capabilities.unavailableMessage(page.url.pathname)} desktopActions={false} />
      {:else if overview.resyncs === 0 && overview.connection === "unavailable" && !page.error}
        <GatewayUnavailable retry={() => location.reload()} />
      {:else if !ready && !page.error}
        <div class="flex h-full flex-col gap-4 p-6" role="status" aria-label="Loading application">
          <Skeleton class="h-6 w-44" />
          <div class="m-auto flex w-full max-w-(--chat-width) flex-col gap-4">
            <Skeleton class="h-8 w-64" /><Skeleton class="h-32 w-full" />
          </div>
        </div>
      {:else if !isSettingsRoute(page.route.id) || page.error}{@render children()}{/if}
    </main>
  </div>
</div>
{#if ready && !capabilities.incompatible}<SettingsOverlay route={children} />{/if}
<CommandPalette registry={commands} {palette} />
{#if ready && !capabilities.incompatible}<AddProjectDialog state={addProject} />{/if}
<Toaster />
<BotSettingsHost />
{#if capabilities.linkedComputers}<BotMoveHost />{/if}
<UpdateBanner />
