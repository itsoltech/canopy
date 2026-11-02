<script lang="ts">
  import { page } from "$app/state";
  import BotsSectionEmpty from "#lib/features/bots/components/BotsSectionEmpty.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { isSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import { needsYou } from "#lib/features/threads/activity.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import ConnectionStatus from "./ConnectionStatus.svelte";
  import Logo from "./Logo.svelte";
  import SectionSwitch from "./SectionSwitch.svelte";
  import { sectionMemory, sectionOf, type Section } from "./sections.svelte.ts";
  import SidebarThreads from "./SidebarThreads.svelte";

  /**
   * App sidebar: logo and the section's "new" action, the Threads | Bots switch (follows the route;
   * Settings keeps the last section), search over the current section, its list, and the footer.
   */
  let { currentThreadId }: { currentThreadId?: string | undefined } = $props();
  const overview = useOverview();

  const section = $derived<Section>(sectionOf(page.url.pathname) ?? sectionMemory.current);
  const queries = $state<Record<Section, string>>({ threads: "", bots: "" });
  const threadsNeedYou = $derived([...overview.threads.values()].some(needsYou));
  const online = $derived(overview.workers.filter((w) => w.online).length);
  // Settings as a page (loaded on its own) or over the current one.
  const settingsActive = $derived(isSettingsRoute(page.route.id) || isSettingsRoute(page.shallow?.route?.id));
  const iconLink =
    "relative grid size-9 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring sm:size-8 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white";
</script>

<div class="flex h-full flex-col">
  <div class="flex h-12 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
    <Logo />
    {#if section === "threads"}
      <a href="/" class={iconLink} aria-label="New thread" title="New thread">
        <Icon name="pencil-square" />
      </a>
    {:else}
      <button
        type="button"
        class={[iconLink, "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-zinc-500 dark:hover:bg-transparent dark:hover:text-zinc-400"]}
        aria-label="New bot chat"
        aria-disabled="true"
        {@attach tooltip("Coming soon", { placement: "bottom-end" })}
      >
        <Icon name="pencil-square" />
      </button>
    {/if}
  </div>

  <SectionSwitch active={section} attention={{ threads: threadsNeedYou }} class="px-3 pb-2" />

  <div class="px-3 pb-2">
    <label class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-zinc-500 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 sm:py-1.5 dark:text-zinc-400">
      <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
      <span class="sr-only">Search {section === "threads" ? "threads" : "bots"}</span>
      <input
        type="search"
        name="q"
        bind:value={queries[section]}
        placeholder={section === "threads" ? "Search threads" : "Search bots"}
        autocomplete="off"
        class="min-w-0 flex-1 bg-transparent text-base/6 text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400"
      />
    </label>
  </div>

  <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={section === "threads" ? "Threads" : "Bots"}>
    {#if section === "threads"}
      <SidebarThreads {currentThreadId} query={queries.threads} />
    {:else}
      <BotsSectionEmpty query={queries.bots} />
    {/if}
  </nav>

  <div class="flex shrink-0 items-center gap-1 border-t border-zinc-950/5 px-2 py-2 dark:border-white/5">
    <a
      href="/settings"
      aria-current={settingsActive ? "page" : undefined}
      class={[iconLink, "aria-[current=page]:text-zinc-950 dark:aria-[current=page]:text-white"]}
      aria-label="Settings"
      title="Settings"
    >
      <Icon name="cog-6-tooth" />
    </a>
    <a
      href="/settings/workers"
      class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm/5 text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring sm:text-xs/5 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
      title="Workers online"
    >
      <Icon name="server" class="size-3.5" />{online}/{overview.workers.length}<span class="sr-only">workers online</span>
    </a>
    <ConnectionStatus connection={overview.connection} class="min-w-0 flex-1 justify-end px-2" />
  </div>
</div>
