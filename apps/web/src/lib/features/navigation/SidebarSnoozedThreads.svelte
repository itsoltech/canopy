<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { sidebarChildren } from "@canopy/domain/sidebar-threads";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import SidebarThread from "./SidebarThread.svelte";
  import SidebarThreadChildren from "./SidebarThreadChildren.svelte";
  import SidebarThreadDisclosure from "./SidebarThreadDisclosure.svelte";

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
  let open = $state(false);
  let searchOpen = $state(true);
  const expanded = $derived(searching ? searchOpen : open);

  $effect(() => {
    if (!searching) searchOpen = true;
  });
</script>

{#if threads.length}
  <section aria-label="Snoozed" data-snoozed-section class="pt-0.5">
    <SidebarThreadDisclosure
      label="Snoozed ({threads.length})"
      {expanded}
      ontoggle={() => {
        if (searching) searchOpen = !searchOpen;
        else open = !open;
      }}
    >
      <ul role="list" aria-label="Snoozed threads" class="grid min-w-0 grid-cols-1 gap-0.5">
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
    </SidebarThreadDisclosure>
  </section>
{/if}
