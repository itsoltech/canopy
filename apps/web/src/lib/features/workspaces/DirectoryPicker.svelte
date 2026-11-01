<script lang="ts">
  import { ui } from "@open-agents/contracts";
  import { pathSeparator } from "#lib/features/overview/workers.ts";
  import { decode } from "#lib/shared/wire.ts";

  /**
   * Browses directories on a worker (inside its allowed roots, enforced by the worker) and
   * returns the chosen path through `value`.
   */
  let { workerId, os, value = $bindable("") }: { workerId: string; os: string; value?: string } = $props();

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

<div class="rounded-lg ring-1 ring-slate-200">
  <div class="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-sm">
    <button type="button" class="btn" disabled={!path || loading} onclick={() => open(parent)}>Up</button>
    <code class="truncate" title={path}>{path || "allowed roots"}</code>
  </div>
  {#if error}
    <p class="px-3 py-2 text-sm text-rose-700" role="alert">{error}</p>
  {:else}
    <ul class="max-h-56 overflow-y-auto text-sm" aria-busy={loading}>
      {#each entries as entry (entry.name)}
        <li>
          <button type="button" class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-slate-50" onclick={() => open(join(path, entry.name))}>
            <span aria-hidden="true">📁</span>{entry.name}
            {#if entry.isGitRepo}<span class="rounded bg-slate-100 px-1 text-xs text-slate-600">git</span>{/if}
          </button>
        </li>
      {:else}
        <li class="px-3 py-2 text-slate-500">No subdirectories</li>
      {/each}
    </ul>
  {/if}
</div>
