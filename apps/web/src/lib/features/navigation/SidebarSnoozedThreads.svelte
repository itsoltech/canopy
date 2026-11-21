<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { sidebarChildren } from "@canopy/domain/sidebar-threads";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
  import SidebarThread from "./SidebarThread.svelte";
  import SidebarThreadChildren from "./SidebarThreadChildren.svelte";

  let {
    threads,
    sides,
    currentThreadId,
    openTree,
    searching,
  }: {
    threads: readonly ui.Thread[];
    sides: ReadonlyMap<string, readonly ui.Thread[]>;
    currentThreadId?: string | undefined;
    openTree?: string | undefined;
    searching: boolean;
  } = $props();

  const overview = useOverview();
  const id = $props.id();
  let open = $state(false);
  let searchOpen = $state(true);
  const expanded = $derived(searching ? searchOpen : open);

  $effect(() => {
    if (!searching) searchOpen = true;
  });
</script>

{#if threads.length}
  <section aria-label="Snoozed" data-snoozed-section class="pt-2">
    <h2>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onclick={() => {
          if (searching) searchOpen = !searchOpen;
          else open = !open;
        }}
        class="sidebar-row-padding flex h-10 w-full items-center gap-1 rounded-lg text-sm font-medium text-zinc-500 focus-ring hover:bg-zinc-950/4 sm:h-9 sm:text-xs dark:text-zinc-400 dark:hover:bg-white/4"
      >
        <span>Snoozed ·</span>
        <span class="min-w-6 text-left tabular-nums">{threads.length}</span>
        <Icon
          name="chevron-right"
          class={["t-acc-chevron ml-auto fill-zinc-400 dark:fill-zinc-500", expanded && "rotate-90"]}
        />
      </button>
    </h2>
    <div {id}>
      {#if expanded}
        <ul
          role="list"
          aria-label="Snoozed threads"
          class="grid min-w-0 grid-cols-1 gap-0.5"
          transition:expand
          onoutrostart={(event) => (event.currentTarget.inert = true)}
          onintrostart={(event) => (event.currentTarget.inert = false)}
        >
          {#each threads as thread (thread.id)}
            {@const children = sidebarChildren(sides.get(thread.id) ?? []).sides}
            {@const showChildren = searching || thread.id === openTree || thread.id === currentThreadId}
            <li class="min-w-0">
              <SidebarThread
                {thread}
                snoozed
                current={thread.id === currentThreadId}
                project={overview.project(thread.projectId)}
                worker={overview.worker(thread.workerId)}
                sides={showChildren ? 0 : children.active.length}
              />
              {#if showChildren && (children.active.length || children.previous.length)}
                <SidebarThreadChildren
                  sides={children}
                  title={thread.title}
                  {currentThreadId}
                  snoozed
                  class="mt-0.5 mb-1 ml-5"
                />
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>
{/if}
