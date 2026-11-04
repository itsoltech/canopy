<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { pathSeparator } from "#lib/features/overview/workers.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import DirectoryShortcuts from "./DirectoryShortcuts.svelte";

  /**
   * Browses accessible directories on a worker and
   * returns the chosen path through `value`: the directory currently open. The list keeps one height:
   * skeleton rows while a directory loads, its entries resolving in once it arrives.
   */
  let {
    workerId,
    os,
    initialPath,
    value = $bindable(""),
    class: className,
  }: { workerId: string; os: string; initialPath?: string | undefined; value?: string; class?: ClassValue } = $props();

  const overview = useOverview();

  let path = $state("");
  let address = $state("");
  let entries = $state.raw<ui.ListDirectoryResponse["entries"]>([]);

  const locations = $derived(
    [
      ...new Set(
        overview.ownProjects
          .filter((p) => p.kind !== "scratch")
          .flatMap((p) => p.workspaces.filter((w) => w.workerId === workerId).map((w) => w.rootPath)),
      ),
    ]
      .slice(-4)
      .reverse(),
  );

  let error = $state<string | undefined>(undefined);
  let loading = $state(false);

  async function open(next: string, signal?: AbortSignal) {
    loading = true;
    value = "";
    error = undefined;

    try {
      const response = await fetch(
        `/api/workers/${encodeURIComponent(workerId)}/directory?${new URLSearchParams({ path: next })}`,
        {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        },
      );

      const payload: unknown = await response.json();

      if (!response.ok) throw new Error((payload as { message?: string }).message ?? `HTTP ${response.status}`);
      const listing = decode(ui.ListDirectoryResponseSchema, payload);
      // Hidden folders (.cache, .config…) after the ones people usually pick.
      entries = listing.entries
        .filter((e) => e.isDir)
        .sort(
          (a, b) => Number(a.name.startsWith(".")) - Number(b.name.startsWith(".")) || a.name.localeCompare(b.name),
        );
      path = listing.path;
      address = path;
      value = path;
    } catch (e) {
      if (!signal?.aborted) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (!signal?.aborted) loading = false;
    }
  }

  $effect(() => {
    const controller = new AbortController();

    if (workerId)
      void open(
        untrack(() => initialPath ?? ""),
        controller.signal,
      );

    return () => controller.abort();
  });

  // Paths are built with the worker's separator (a Windows worker gets `C:\code\app`).
  const join = (base: string, name: string) =>
    base ? `${base.replace(/[/\\]$/, "")}${pathSeparator(os)}${name}` : name;

  const parent = $derived.by(() => {
    const trimmed = path.replace(/[/\\]+$/, "");
    const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));

    if (os === "win32" && /^[A-Za-z]:$/.test(trimmed)) return path;

    if (os === "win32" && /^\\\\[^\\]+\\[^\\]+$/.test(trimmed)) return path;

    if (index <= 0) return pathSeparator(os);
    const next = trimmed.slice(0, index);

    return os === "win32" && /^[A-Za-z]:$/.test(next) ? `${next}\\` : next;
  });
</script>

<div class={["grid min-w-0 gap-3", className]}>
  <div class="flex min-w-0 items-center gap-2">
    <div class="min-w-0 flex-1">
      <Input
        name="directoryAddress"
        aria-label="Directory path"
        bind:value={address}
        disabled={loading}
        placeholder={os === "win32" ? "C:\\Users\\you\\project" : "/home/you/project"}
        oninput={() => (value = "")}
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (!loading && address.trim()) void open(address.trim());
          }
        }}
      />
    </div>
    <Button size="sm" disabled={loading || !address.trim()} onclick={() => open(address.trim())}>Go</Button>
  </div>
  <DirectoryShortcuts {locations} disabled={loading} onopen={(location) => open(location)} />
  <div class="overflow-hidden rounded-lg ring-1 ring-zinc-950/10 dark:ring-white/10">
    <div
      class="flex items-center gap-2 border-b border-zinc-950/5 bg-zinc-950/2.5 py-1 pr-3 pl-1 dark:border-white/5 dark:bg-white/5"
    >
      <IconButton
        icon="arrow-left"
        label="Up one level"
        size="sm"
        disabled={!path || path === parent || loading}
        onclick={() => open(parent)}
      />
      <p class="min-w-0 flex-1 truncate font-mono text-base/6 sm:text-sm/6" title={path} aria-live="polite">
        {path || "Home"}
      </p>
      <Spinner class={["text-zinc-400", !loading && "invisible"]} />
    </div>
    {#if error}
      <div class="p-2"><Alert tone="error">{error}</Alert></div>
    {/if}
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
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-base/6 focus-ring hover:bg-zinc-950/5 focus-visible:-outline-offset-2 sm:py-1 sm:text-sm/6 dark:hover:bg-white/5"
              onclick={() => open(join(path, entry.name))}
            >
              <Icon name="folder" class="fill-zinc-400 dark:fill-zinc-500" />
              <span class="min-w-0 flex-1 truncate">{entry.name}</span>
              {#if entry.isGitRepo}<Badge>git</Badge>{/if}
            </button>
          </li>
        {:else}
          <li class="px-3 py-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">No subdirectories.</li>
        {/each}
      {/if}
    </ul>
  </div>
</div>
