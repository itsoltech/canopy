<script lang="ts">
  import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import * as api from "./api.ts";

  let {
    repositoryName,
    accountId,
    disabled = false,
    onchanged,
  }: {
    repositoryName: string;
    accountId: string;
    disabled?: boolean;
    onchanged: () => void;
  } = $props();

  let busy = $state(false);
  let error = $state("");
  const node = $derived(splitId(accountId).node);
  const homeId = $derived(node ? `${GITHUB_HOME}~${node}` : "");
  const read = $derived(
    new SharedRead(queries, `GitHubRepositoryAccount:${homeId}:${repositoryName}`, () =>
      api.repositoryAccount(homeId, repositoryName),
    ),
  );

  async function choose(id: string) {
    if (!read.data || busy) return;
    busy = true;
    error = "";

    try {
      read.set(await api.chooseAccount(homeId, repositoryName, id, read.data.revision));
      onchanged();
    } catch {
      error = "Could not change this account. Refresh, then retry.";
    } finally {
      busy = false;
    }
  }
</script>

{#if read.data && read.data.candidates.length > 1}
  <div class="grid min-w-0 gap-1 text-sm/5 sm:text-xs/4">
    <Select
      inline
      aria-label="GitHub account"
      value={read.data.accountId}
      options={read.data.candidates.map((a) => ({ value: a.id, label: a.login }))}
      disabled={disabled || busy}
      onchange={(id) => void choose(id)}
    />
    {#if error}<p role="alert" class="text-amber-700 dark:text-amber-400">{error}</p>{/if}
  </div>
{/if}
