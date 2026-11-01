<script lang="ts">
  import "./layout.css";
  import favicon from "#lib/assets/favicon.svg";
  import { ui } from "@open-agents/contracts";
  import { afterNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { untrack } from "svelte";
  import { ActiveProject, provideActiveProject } from "#lib/features/navigation/active-project.svelte.ts";
  import AppNav from "#lib/features/navigation/AppNav.svelte";
  import Logo from "#lib/features/navigation/Logo.svelte";
  import { OverviewState, provideOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Drawer from "#lib/shared/ui/Drawer.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  // One live overview per tab: seeded once from the server load, then kept current by SSE.
  const initial = untrack(() => data.overview);
  const overview = new OverviewState(initial ? decode(ui.GetOverviewResponseSchema, initial) : undefined);
  provideOverview(overview);
  $effect(() => overview.connect());

  const active = new ActiveProject();
  provideActiveProject(active);
  const projectId = $derived(page.params.projectId ?? active.fromThread);

  let menuOpen = $state(false);
  afterNavigate(() => (menuOpen = false));
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>Open Agents</title>
</svelte:head>

<div class="isolate flex h-dvh flex-col bg-white text-zinc-950 lg:flex-row dark:bg-zinc-950 dark:text-white">
  <!-- Desktop sidebar -->
  <aside class="w-64 shrink-0 border-r border-zinc-950/5 bg-zinc-50 max-lg:hidden dark:border-white/5 dark:bg-zinc-900/60">
    <AppNav {projectId} />
  </aside>

  <!-- Mobile top bar + drawer -->
  <div class="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-950/5 px-2 lg:hidden dark:border-white/5">
    <IconButton icon="bars-3" label="Open menu" onclick={() => (menuOpen = true)} />
    <Logo />
  </div>
  <Drawer bind:open={menuOpen} label="Main menu">
    <AppNav {projectId} />
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
