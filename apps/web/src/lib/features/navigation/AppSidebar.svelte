<script lang="ts">
  import { page } from "$app/state";
  import LiveBotsNav from "#lib/features/bots/components/LiveBotsNav.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { isSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import { needsYou, unseenResult } from "#lib/features/threads/activity.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ConnectionStatus from "./ConnectionStatus.svelte";
  import UpdatesIndicator from "#lib/features/desktop/UpdatesIndicator.svelte";
  import SidebarHeader from "./SidebarHeader.svelte";
  import SectionSwitch from "./SectionSwitch.svelte";
  import { sectionMemory, sectionOf, type Section } from "./sections.svelte.ts";
  import SidebarThreads from "./SidebarThreads.svelte";
  import SidebarProjectFilter from "./SidebarProjectFilter.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  const capabilities = useGatewayCapabilities();

  /**
   * App sidebar: logo and the section's "new" action, the Threads | Bots switch (follows the route;
   * Settings keeps the last section), search over the current section, its list, and the footer.
   */
  let { currentThreadId }: { currentThreadId?: string | undefined } = $props();
  const overview = useOverview();

  const section = $derived<Section>(sectionOf(page.url.pathname) ?? sectionMemory.current);
  const queries = $state<Record<Section, string>>({ threads: "", bots: "" });

  const threadsAttention = $derived.by(() => {
    const threads = [...overview.threads.values()];

    return threads.some(needsYou) ? "needs" : threads.some((t) => unseenResult(t) !== undefined) ? "unseen" : undefined;
  });

  const online = $derived(overview.workers.filter((w) => w.online).length);

  // Settings as a page (loaded on its own) or over the current one.
  const settingsActive = $derived(isSettingsRoute(page.route.id) || isSettingsRoute(page.shallow?.route?.id));

  const iconLink =
    "relative grid size-9 place-items-center rounded-lg text-icon-muted hover:bg-zinc-950/5 hover:text-icon-emphasis focus-ring sm:size-8 dark:hover:bg-white/5";
</script>

<div class="flex h-full flex-col">
  <SidebarHeader>
    {#if section === "threads"}
      <a href="/" class={iconLink} aria-label="New thread" title="New thread">
        <Icon name="pencil-square" />
      </a>
    {:else}
      <a href="/bots?create=1" class={iconLink} aria-label="Create bot">
        <Icon name="pencil-square" />
      </a>
    {/if}
  </SidebarHeader>

  {#if capabilities?.supports("/bots") ?? true}<SectionSwitch
      active={section}
      attention={{ threads: threadsAttention }}
      class="px-3 pb-2"
    />{/if}

  <div class="flex items-center gap-1 px-3 pb-2">
    <label
      class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-zinc-500 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 sm:py-1.5 dark:text-zinc-400"
    >
      <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
      <span class="sr-only">Search {section === "threads" ? "threads" : "bots"}</span>
      <input
        type="search"
        name="q"
        bind:value={queries[section]}
        placeholder={section === "threads" ? "Search threads" : "Search bots"}
        autocomplete="off"
        class="min-w-0 flex-1 bg-transparent text-base/6 text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {#if queries[section]}
        <button
          type="button"
          aria-label="Clear search"
          onclick={() => (queries[section] = "")}
          class="-my-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-zinc-400 focus-ring hover:bg-zinc-950/5 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200"
        >
          <Icon name="x-mark" class="size-3.5" />
        </button>
      {/if}
    </label>
    {#if section === "threads"}<SidebarProjectFilter />{/if}
  </div>

  <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={section === "threads" ? "Threads" : "Bots"}>
    {#if section === "threads"}
      <SidebarThreads {currentThreadId} query={queries.threads} />
    {:else}
      <LiveBotsNav query={queries.bots} />
    {/if}
  </nav>

  <div class="flex shrink-0 items-center gap-1 border-t border-zinc-950/5 px-2 py-2 dark:border-white/5">
    <a
      href="/settings"
      aria-current={settingsActive ? "page" : undefined}
      class={[iconLink, "aria-[current=page]:text-icon-emphasis"]}
      aria-label="Settings"
      title="Settings"
    >
      <Icon name="cog-6-tooth" />
    </a>
    <a
      href="/settings/workers"
      class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm/5 text-zinc-500 focus-ring hover:bg-zinc-950/5 hover:text-zinc-950 sm:text-xs/5 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
      title="Workers online"
    >
      <Icon name="server" class="size-3.5" />{online}/{overview.workers.length}<span class="sr-only"
        >workers online</span
      >
    </a>
    <UpdatesIndicator />
    <ConnectionStatus
      connection={overview.connection}
      quietWhenLive={capabilities?.ownGateway ?? false}
      class="min-w-0 flex-1 justify-end px-2"
    />
  </div>
</div>
