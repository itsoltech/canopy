<script lang="ts">
  import { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { pathSeparator } from "#lib/features/overview/workers.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { decode } from "#lib/shared/wire.ts";

  /**
   * Browses directories on a worker (inside its allowed roots, enforced by the worker) and
   * returns the chosen path through `value`: the directory currently open. The list keeps one height:
   * skeleton rows while a directory loads, its entries resolving in once it arrives.
   */
  let { workerId, os, value = $bindable(""), class: className }: { workerId: string; os: string; value?: string; class?: ClassValue } = $props();

  let path = $state("");
  let entries = $state.raw<ui.ListDirectoryResponse["entries"]>([]);
  // Allowed roots (absolute paths): "Up" from a root goes back to the list of roots.
  let roots = $state.raw<string[]>([]);
  let error = $state<string | undefined>(undefined);
  let loading = $state(false);

  async function open(next: string) {
    loading = true;
    error = undefined;
    try {
      const response = await fetch(`/api/workers/${encodeURIComponent(workerId)}/directory?${new URLSearchParams({ path: next })}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error((payload as { message?: string }).message ?? `HTTP ${response.status}`);
      entries = decode(ui.ListDirectoryResponseSchema, payload).entries.filter((e) => e.isDir);
      if (!next) roots = entries.map((e) => e.name);
      path = next;
      value = next;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (workerId) void open("");
  });

  // Paths are built with the worker's separator (a Windows worker gets `C:\code\app`).
  const join = (base: string, name: string) => (base ? `${base.replace(/[/\\]$/, "")}${pathSeparator(os)}${name}` : name);
  const parent = $derived(roots.includes(path) ? "" : path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))));
</script>

<div class={["overflow-hidden rounded-lg ring-1 ring-zinc-950/10 dark:ring-white/10", className]}>
  <div class="flex items-center gap-2 border-b border-zinc-950/5 bg-zinc-950/2.5 py-1 pr-3 pl-1 dark:border-white/5 dark:bg-white/5">
    <IconButton icon="arrow-left" label="Up one level" size="sm" disabled={!path || loading} onclick={() => open(parent)} />
    <code class="min-w-0 flex-1 truncate font-mono text-sm/6 sm:text-[0.8125rem]/6" title={path} aria-live="polite">{path || "Allowed directories"}</code>
    <Spinner class={["text-zinc-400", !loading && "invisible"]} />
  </div>
  {#if error}
    <Alert tone="error" class="m-2">{error}</Alert>
  {:else}
    <ul role="list" class="h-56 overflow-y-auto py-1" aria-busy={loading} aria-label="Subdirectories">
      {#if loading}
        <!-- Rows as tall as an entry. -->
        {#each ["w-3/5", "w-2/5", "w-3/4", "w-1/2", "w-1/3"] as width (width)}
          <li class="flex items-center gap-2 px-3 py-3 sm:py-2" aria-hidden="true">
            <Skeleton class="size-4 rounded-sm" /><Skeleton class={["h-3.5", width]} />
          </li>
        {/each}
        <li class="sr-only">Loading…</li>
      {:else}
        {#each entries as entry (entry.name)}
          <li class="t-reveal">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-base/6 hover:bg-zinc-950/5 focus-ring focus-visible:-outline-offset-2 sm:py-1 sm:text-sm/6 dark:hover:bg-white/5"
              onclick={() => open(join(path, entry.name))}
            >
              <Icon name="folder" class="fill-zinc-400 dark:fill-zinc-500" />
              <span class="min-w-0 flex-1 truncate">{entry.name}</span>
              {#if entry.isGitRepo}<Badge>git</Badge>{/if}
            </button>
          </li>
        {:else}
          <li class="px-3 py-2 text-sm/6 text-zinc-500 dark:text-zinc-400">No subdirectories.</li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>
