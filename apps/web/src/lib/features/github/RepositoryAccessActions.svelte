<script lang="ts">
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import ConnectGitHub from "./ConnectGitHub.svelte";
  import * as api from "./api.ts";

  let { homeId, onconnected }: { homeId: string; onconnected: () => void } = $props();
  const read = $derived(new SharedRead(queries, `GitHubAccessAccounts:${homeId}`, () => api.accounts(homeId)));
</script>

<div class="flex flex-wrap items-center gap-2">
  {#if read.data?.accounts.some((a) => a.status === "connected")}
    <ButtonLink
      href={read.data.installUrl || "/settings/github"}
      target={read.data.installUrl ? "_blank" : undefined}
      rel="noreferrer"
      size="sm">Manage access</ButtonLink
    >
  {:else}
    <ConnectGitHub {homeId} configured={read.data?.configured ?? true} {onconnected} />
  {/if}
</div>
