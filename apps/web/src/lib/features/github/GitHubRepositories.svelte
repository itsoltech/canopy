<script lang="ts">
  import { onMount } from "svelte";
  import type { github } from "@canopy/contracts";
  import * as api from "./api.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";

  let {
    accountId,
    installationId,
    class: className,
  }: { accountId: string; installationId: string; class?: string } = $props();

  let repos = $state<github.GitHubRepository[]>([]);
  let next = $state(0);
  let total = $state(0);
  let all = $state(false);
  let query = $state("");
  let busy = $state(false);
  let loaded = $state(false);
  let error = $state("");
  const matches = $derived(repos.filter((repo) => repo.fullName.toLowerCase().includes(query.trim().toLowerCase())));
  const shown = $derived(all || query ? matches : matches.slice(0, 5));

  async function load(remaining = false) {
    if (busy) return;
    busy = true;
    error = "";

    try {
      let page = remaining ? next : 0;

      do {
        const value = await api.repositories(accountId, installationId, page);
        repos = page ? [...repos, ...value.repositories] : value.repositories;
        total = value.totalCount;
        next = value.nextPage;
        loaded = true;
        page = next;
      } while (remaining && page);
    } catch {
      error = "Could not load repositories. Check access on GitHub, then retry.";
    } finally {
      busy = false;
    }
  }

  function search(value: string) {
    query = value;

    if (next) void load(true);
  }

  onMount(() => {
    void load();
  });
</script>

<div class={["grid min-w-0 gap-2", className]}>
  {#if total > 10}<SearchField
      label="Search repositories"
      placeholder="Search repositories…"
      value={query}
      oninput={(event) => search(event.currentTarget.value)}
    />{/if}
  <ul
    role="list"
    aria-label="Repositories"
    class={["grid min-w-0", (all || query) && "max-h-72 overflow-y-auto overscroll-contain"]}
  >
    {#each shown as repo (repo.repositoryId)}
      <li class="flex min-w-0 items-center gap-2 py-1.5 text-base/5 sm:text-sm/5">
        <MiddleTruncatedText text={repo.fullName} class="flex-1" />
        <Badge compact>{repo.private ? "Private" : "Public"}</Badge>
      </li>
    {/each}
  </ul>
  {#if loaded && !shown.length && !busy && !error}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
      {query
        ? "No repositories match your search."
        : "No accessible repositories. Choose repositories on GitHub or ask an administrator for access."}
    </p>{/if}
  {#if total > 5 && !query}<div>
      <Button
        size="sm"
        variant="text"
        aria-expanded={all}
        disabled={busy}
        onclick={() => {
          all = !all;
          if (all && next) void load(true);
        }}>{all ? "Show fewer" : `Show all ${total}`}</Button
      >
    </div>{/if}
  {#if busy}<p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">Loading repositories…</p>{/if}
  {#if error}<p role="alert" class="text-sm/5 text-zinc-500 dark:text-zinc-400">{error}</p>
    <div><Button size="sm" onclick={() => load(Boolean(next))}>Retry</Button></div>{/if}
</div>
