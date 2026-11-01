<script lang="ts">
  import "./layout.css";
  import favicon from "#lib/assets/favicon.svg";
  import { ui } from "@open-agents/contracts";
  import { afterNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { untrack } from "svelte";
  import AppSidebar from "#lib/features/navigation/AppSidebar.svelte";
  import { returnTo } from "#lib/features/settings/return-to.svelte.ts";
  import { provideShell } from "#lib/features/navigation/shell.ts";
  import { OverviewState, provideOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Drawer from "#lib/shared/ui/Drawer.svelte";
  // Keeps the color scheme in sync with the system while the choice is "system".
  import "#lib/shared/preferences.svelte.ts";
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

  let menuOpen = $state(false);
  provideShell({ openMenu: () => (menuOpen = true) });
  afterNavigate(({ to }) => {
    menuOpen = false;
    // Closing Settings returns to the last page outside it.
    if (to && !to.url.pathname.startsWith("/settings")) returnTo.url = `${to.url.pathname}${to.url.search}`;
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>Open Agents</title>
</svelte:head>

<div class="isolate flex h-dvh bg-white text-zinc-950 dark:bg-black dark:text-white">
  <aside class="w-72 shrink-0 border-r border-zinc-950/5 bg-zinc-50 max-lg:hidden dark:border-white/8 dark:bg-zinc-950">
    <AppSidebar currentThreadId={page.params.threadId} />
  </aside>
  <Drawer bind:open={menuOpen} label="Threads">
    <AppSidebar currentThreadId={page.params.threadId} />
  </Drawer>

  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if overview.connection === "unavailable"}
      <Alert tone="warning" banner>The gateway is not responding. Showing the last known state; retrying automatically.</Alert>
    {/if}
    <main class="min-h-0 flex-1">
      {@render children()}
    </main>
  </div>
</div>
