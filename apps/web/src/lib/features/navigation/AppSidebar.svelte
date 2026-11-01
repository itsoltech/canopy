<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { page } from "$app/state";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { isSide } from "#lib/features/threads/thread-tree.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ConnectionStatus from "./ConnectionStatus.svelte";
  import Logo from "./Logo.svelte";
  import SidebarSideThread from "./SidebarSideThread.svelte";
  import SidebarThread from "./SidebarThread.svelte";

  /**
   * Thread inbox (T3 style): every main thread of every project, those that need you first, then the
   * newest. The open thread's side threads unfold under it; others show a count.
   */
  let { currentThreadId }: { currentThreadId?: string | undefined } = $props();
  const overview = useOverview();

  let query = $state("");
  const all = $derived([...overview.threads.values()]);
  const byId = $derived(new Map(all.map((t) => [t.id, t])));
  const sidesOf = $derived.by(() => {
    const map = new Map<string, ui.Thread[]>();
    for (const t of all) if (isSide(t) && byId.has(t.parentThreadId)) map.set(t.parentThreadId, [...(map.get(t.parentThreadId) ?? []), t]);
    return map;
  });
  const current = $derived(currentThreadId ? byId.get(currentThreadId) : undefined);
  const openTree = $derived(current ? (isSide(current) ? current.parentThreadId : current.id) : undefined);

  const needsYou = (t: ui.Thread) => t.status === "waiting_input" || t.pendingInteractions > 0;
  const newest = (a: ui.Thread, b: ui.Thread) => Number((b.createdAt?.seconds ?? 0n) - (a.createdAt?.seconds ?? 0n));
  const mains = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const projectName = (t: ui.Thread) => overview.project(t.projectId)?.name ?? "";
    return all
      .filter((t) => !(isSide(t) && byId.has(t.parentThreadId)))
      .filter((t) => !q || [t, ...(sidesOf.get(t.id) ?? [])].some((x) => x.title.toLowerCase().includes(q)) || projectName(t).toLowerCase().includes(q))
      .sort((a, b) => {
        const attention = Number(needsYou(b) || (sidesOf.get(b.id) ?? []).some(needsYou)) - Number(needsYou(a) || (sidesOf.get(a.id) ?? []).some(needsYou));
        return attention || newest(a, b);
      });
  });
  const online = $derived(overview.workers.filter((w) => w.online).length);
  const settingsActive = $derived(page.url.pathname.startsWith("/settings"));
</script>

<div class="flex h-full flex-col">
  <div class="flex h-12 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
    <Logo />
    <a
      href="/"
      class="relative grid size-9 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring sm:size-8 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
      aria-label="New thread"
      title="New thread"
    >
      <Icon name="pencil-square" />
    </a>
  </div>

  <div class="px-3 pb-2">
    <label class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-zinc-500 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 sm:py-1.5 dark:text-zinc-400">
      <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
      <span class="sr-only">Search threads</span>
      <input
        type="search"
        name="q"
        bind:value={query}
        placeholder="Search"
        autocomplete="off"
        class="min-w-0 flex-1 bg-transparent text-base/6 text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400"
      />
    </label>
  </div>

  <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Threads">
    {#if mains.length === 0}
      <p class="px-3 py-2 text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400">
        {#if query}No thread matches “{query}”.{:else if overview.connection === "unavailable"}Threads load once the gateway answers.{:else}No threads yet. Start one with the pencil above.{/if}
      </p>
    {:else}
      <ul role="list" class="grid gap-0.5">
        {#each mains as thread (thread.id)}
          {@const sides = sidesOf.get(thread.id) ?? []}
          <li>
            <SidebarThread
              {thread}
              project={overview.project(thread.projectId)}
              worker={overview.worker(thread.workerId)}
              sides={openTree === thread.id ? 0 : sides.length}
              current={thread.id === currentThreadId}
            />
            {#if openTree === thread.id && sides.length > 0}
              <ul role="list" aria-label="Side threads of {thread.title}" class="mt-0.5 mb-1 ml-5 grid gap-0.5 border-l border-zinc-950/10 pl-1.5 dark:border-white/10">
                {#each [...sides].sort(newest).reverse() as side (side.id)}
                  <li><SidebarSideThread thread={side} current={side.id === currentThreadId} /></li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </nav>

  <div class="flex shrink-0 items-center gap-1 border-t border-zinc-950/5 px-2 py-2 dark:border-white/5">
    <a
      href="/settings"
      aria-current={settingsActive ? "page" : undefined}
      class="relative grid size-9 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring aria-[current=page]:text-zinc-950 sm:size-8 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:text-white"
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
