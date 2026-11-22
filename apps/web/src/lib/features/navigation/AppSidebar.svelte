<script lang="ts">
  import "./sidebar-rows.css";
  import { page } from "$app/state";
  import { remoteDrafts } from "#lib/features/drafts/remote.svelte.ts";
  import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
  import LiveBotsNav from "#lib/features/bots/components/LiveBotsNav.svelte";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { isSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import { needsYou, unseenResult } from "#lib/features/threads/activity.ts";
  import { isThreadSnoozed } from "@canopy/domain/thread-snooze";
  import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
  import { sidebarIdentity } from "@canopy/ui/sidebar-art";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ConnectionStatus from "./ConnectionStatus.svelte";
  import UpdatesIndicator from "#lib/features/desktop/UpdatesIndicator.svelte";
  import SidebarUsage from "#lib/features/providers/SidebarUsage.svelte";
  import SidebarHeader from "./SidebarHeader.svelte";
  import SectionSwitch from "./SectionSwitch.svelte";
  import type { ModuleId } from "@canopy/domain";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { sectionMemory, sectionOf } from "./sections.svelte.ts";
  import SidebarThreads from "./SidebarThreads.svelte";
  import SidebarProjectFilter from "./SidebarProjectFilter.svelte";
  import SidebarSort from "./SidebarSort.svelte";
  import SidebarCopyJobs from "#lib/features/projects/SidebarCopyJobs.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import { useAddProject } from "#lib/features/projects/add/add-project.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { footerPopovers } from "./footer-popovers.svelte.ts";

  const channel = releaseChannel(CANOPY_VERSION);
  const identity = sidebarIdentity[channel];
  const footer = footerPopovers();
  const capabilities = useGatewayCapabilities();
  const addProject = useAddProject();

  /**
   * App sidebar: logo, the Threads | Bots switch (follows the route;
   * Settings keeps the last section), search over the current section, its list, and the footer.
   */
  let { currentThreadId, onOpenUsage }: { currentThreadId?: string | undefined; onOpenUsage: () => void } = $props();
  const overview = useOverview();

  const settings = useSettings();
  const requested = $derived(sectionOf(page.url.pathname) ?? sectionMemory.current);
  const section = $derived(requested && settings.moduleEnabled(requested) ? requested : settings.enabledModules[0]);
  const queries = $state<Record<ModuleId, string>>({ threads: "", bots: "" });

  $effect(() => {
    if (!settings.loaded || section !== "threads" || !webDrafts.ready) return;
    void remoteDrafts.load().catch(() => {});

    return remoteDrafts.subscribe();
  });

  $effect(() => {
    const query = queries.threads;
    const timer = setTimeout(() => (overview.warmQuery = query), 500);

    return () => clearTimeout(timer);
  });

  const threadsAttention = $derived.by(() => {
    const threads = [...overview.threads.values()].filter(
      (thread) => !isThreadSnoozed(thread, (id) => overview.threads.get(id)),
    );

    return threads.some(needsYou) ? "needs" : threads.some((t) => unseenResult(t) !== undefined) ? "unseen" : undefined;
  });

  // Bots: unread messages as a number on the Bots segment; a card waiting for you without unread ones as a dot.
  $effect(() => (settings.loaded && settings.moduleEnabled("bots") ? botList.use() : undefined));

  const liveBots = $derived(botList.list.filter((bot) => !bot.archived));
  const botsUnread = $derived(liveBots.reduce((sum, bot) => sum + bot.unreadCount, 0));

  const botsAttention = $derived(
    liveBots.some((bot) => bot.pendingApproval && !overview.threadSnoozed(bot.pendingApproval.threadId))
      ? "needs"
      : undefined,
  );

  const workerCount = $derived(overview.workers.length);
  const online = $derived(overview.workers.filter((w) => w.online).length);

  // Settings as a page (loaded on its own) or over the current one.
  const settingsActive = $derived(isSettingsRoute(page.route.id) || isSettingsRoute(page.shallow?.route?.id));

  const iconLink =
    "relative grid size-9 place-items-center rounded-lg text-icon-muted hover:bg-zinc-950/5 hover:text-icon-emphasis focus-ring sm:size-8 dark:hover:bg-white/5";
</script>

<!-- Compact chrome (docs/ui-scale.md): text one step below the pages beside it. -->
<div class="density-chrome sidebar-scale @container relative isolate flex h-full flex-col">
  <div
    class="sidebar-watermark pointer-events-none absolute inset-x-0 top-[28%] bottom-[4%] -z-10 overflow-hidden forced-colors:hidden"
    style:--ink-light={identity.ink.light}
    style:--ink-dark={identity.ink.dark}
    aria-hidden="true"
  >
    {@html identity.art}
  </div>
  <SidebarHeader {channel}>
    {#if settings.loaded && section === "bots"}
      <a href="/bots?create=1" class={iconLink} aria-label="Create bot">
        <Icon name="pencil-square" />
      </a>
    {/if}
  </SidebarHeader>

  {#if settings.loaded}
    {#if settings.enabledModules.length > 1 && (capabilities?.supports("/bots") ?? true)}<SectionSwitch
        sections={settings.enabledModules}
        active={section}
        attention={{ threads: threadsAttention, bots: botsAttention }}
        counts={{ bots: botsUnread }}
        class="sidebar-gutter pb-2"
      />{/if}

    <div class="sidebar-inset flex items-center pb-2">
      <label
        class={[
          "flex min-w-0 flex-1 items-center rounded-lg py-2 text-zinc-500 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 sm:py-1.5 dark:text-zinc-400",
          section === "threads" ? "gap-1 pl-(--sidebar-row-padding)" : "sidebar-row-padding gap-1.5",
        ]}
      >
        <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
        <span class="sr-only">Search {section === "threads" ? "threads" : "bots"}</span>
        <input
          type="search"
          name="q"
          bind:value={queries[section]}
          placeholder={section === "threads" ? "Search threads" : "Search bots"}
          autocomplete="off"
          class="min-w-0 flex-1 bg-transparent text-base/6 text-ellipsis text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400 [&::-webkit-search-cancel-button]:hidden"
        />
        {#if queries[section]}
          <span class="flex size-6 shrink-0 items-center justify-center">
            <button
              type="button"
              aria-label="Clear search"
              onclick={() => (queries[section] = "")}
              class="-my-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-zinc-400 focus-ring hover:bg-zinc-950/5 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200"
            >
              <Icon name="x-mark" class="size-3.5" />
            </button>
          </span>
        {/if}
      </label>
      {#if section === "threads"}
        <div class="flex shrink-0 items-center">
          <SidebarSort />
          <SidebarProjectFilter />
          {#if addProject}<IconButton
              icon="folder-plus"
              label="Add project"
              tooltipOptions={{ hotkey: keybindings.get("new-project")[0] }}
              onclick={() => addProject.show()}
            />{/if}
          <a href="/threads/new" class={iconLink} aria-label="New thread" {@attach tooltip("New thread")}>
            <Icon name="pencil-square" />
          </a>
        </div>
      {/if}
    </div>

    <nav
      class="sidebar-inset min-h-0 flex-1 scroll-stable overflow-y-auto pb-3"
      aria-label={section === "threads" ? "Threads" : "Bots"}
    >
      {#if section === "threads"}
        <SidebarThreads {currentThreadId} query={queries.threads} />
      {:else}
        <LiveBotsNav query={queries.bots} />
      {/if}
    </nav>

    {#if settings.moduleEnabled("threads")}<SidebarCopyJobs />{/if}
  {:else}
    <div class="flex-1"></div>
  {/if}

  <div
    class="sidebar-inset flex shrink-0 items-center gap-1 border-t border-zinc-950/5 py-2 @max-[16rem]:gap-0 dark:border-white/5"
  >
    <a
      href="/settings"
      class={[iconLink, "shrink-0", settingsActive && "text-icon-emphasis"]}
      aria-label="Open settings"
      title="Open settings"
    >
      <Icon name="cog-6-tooth" />
    </a>
    {#if capabilities?.supports("/usage") ?? true}
      <IconButton icon="table-cells" label="Open usage" onclick={onOpenUsage} />
    {/if}
    {#if overview.resyncs > 0 && workerCount !== 1}
      <a
        href="/settings/workers"
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm/5 text-zinc-500 focus-ring hover:bg-zinc-950/5 hover:text-zinc-950 sm:text-xs/5 @max-[16rem]:gap-0 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
        title="Workers online"
      >
        <Icon name="server" class="size-3.5" />
        <span class="tabular-nums @max-[16rem]:sr-only">{online}/{workerCount}</span>
        <span class="sr-only">workers online</span>
      </a>
    {/if}
    <UpdatesIndicator panel={footer.updates} />
    <SidebarUsage panel={footer.providerUsage} />
    <ConnectionStatus
      hasSnapshot={overview.resyncs > 0}
      recovery={overview.recovery}
      connection={overview.connection}
      quietWhenLive={capabilities?.ownGateway ?? false}
      class="ml-auto min-w-0"
    />
  </div>
</div>

<style>
  .sidebar-watermark {
    color: light-dark(var(--ink-light), var(--ink-dark));
  }
</style>
