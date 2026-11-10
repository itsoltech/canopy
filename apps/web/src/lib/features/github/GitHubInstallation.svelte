<script lang="ts">
  import type { github } from "@canopy/contracts";
  import * as api from "./api.ts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";

  let {
    accountId,
    installation,
    class: className = "",
  }: { accountId: string; installation: github.GitHubInstallation; class?: string } = $props();

  let repos = $state<github.GitHubRepository[]>([]);
  let next = $state(0);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state("");

  async function load(page = 0) {
    if (busy) return;
    busy = true;
    error = "";

    try {
      const value = await api.repositories(accountId, installation.installationId, page);
      repos = page ? [...repos, ...value.repositories] : value.repositories;
      next = value.nextPage;
      loaded = true;
    } catch {
      error = "Could not load repositories. Check access on GitHub, then retry.";
    } finally {
      busy = false;
    }
  }
</script>

<Disclosure
  class={className}
  onchange={(open) => {
    if (open && !loaded) void load();
  }}
>
  {#snippet summary()}<div class="min-w-0 text-base font-medium wrap-anywhere sm:text-sm">
      {installation.login}{installation.suspended ? " · Suspended" : ""}
    </div>{/snippet}
  <div class="flex min-w-0 flex-col gap-3 py-3 pl-6">
    <div>
      <ButtonLink size="sm" href={installation.manageUrl} target="_blank" rel="noreferrer"
        >Manage repositories</ButtonLink
      >
    </div>
    {#if installation.suspended}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        This installation is suspended. Ask its administrator to restore access.
      </p>{/if}
    {#if error}<p role="alert" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{error}</p>
      <div><Button size="sm" onclick={() => load()}>Retry</Button></div>{/if}
    <ul role="list" class="flex max-h-80 flex-col gap-2 overflow-y-auto">
      {#each repos as repo (repo.repositoryId)}<li class="min-w-0 text-base/6 wrap-anywhere sm:text-sm/6">
          {repo.fullName}<span class="text-zinc-500 dark:text-zinc-400"
            >{repo.private ? " · Private" : " · Public"}</span
          >
        </li>{/each}
    </ul>
    {#if loaded && !repos.length && !installation.suspended}<p
        class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
      >
        No accessible repositories. Choose repositories on GitHub or ask an administrator for access.
      </p>{/if}
    {#if busy}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Loading repositories…
      </p>{/if}
    {#if next}<div>
        <Button size="sm" disabled={busy} onclick={() => load(next)}>Load more repositories</Button>
      </div>{/if}
  </div>
</Disclosure>
