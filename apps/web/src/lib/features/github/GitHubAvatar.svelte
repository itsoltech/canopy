<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import { avatar } from "./api.ts";

  let {
    login,
    url = "",
    pullRequestId = "",
    accountId = "",
    compact = false,
    class: className,
  }: {
    login: string;
    url?: string;
    pullRequestId?: string;
    accountId?: string;
    compact?: boolean;
    class?: ClassValue;
  } = $props();

  let failed = $state("");

  const read = $derived(
    (url && pullRequestId) || accountId
      ? new SharedRead(queries, `GitHubAvatar:${pullRequestId}:${accountId}:${url}`, () =>
          avatar(pullRequestId, url, accountId),
        )
      : undefined,
  );

  const source = $derived(read?.data?.dataUrl ?? "");
</script>

<span
  class={[
    "relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-100 font-medium text-zinc-800 ring-1 ring-zinc-950/5 ring-inset dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10",
    compact ? "size-5 text-xs" : "size-8 text-sm",
    className,
  ]}
  aria-hidden="true"
>
  {#if !source || failed === source}{login.slice(0, 2).toUpperCase()}{/if}
  {#if source && failed !== source}
    <img
      src={source}
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      class="absolute inset-0 size-full object-cover"
      onerror={() => (failed = source)}
    />
  {/if}
</span>
