<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import PullRequestPanel from "#lib/features/github/PullRequestPanel.svelte";
  import { pullRequestHref } from "#lib/features/github/presentation.ts";

  const thread = $derived(page.url.searchParams.get("thread"));

  $effect(() => {
    if (thread && page.params.id) void goto(pullRequestHref(thread, page.params.id), { replaceState: true });
  });
</script>

{#if !thread}<PullRequestPanel id={page.params.id ?? ""} />{/if}
