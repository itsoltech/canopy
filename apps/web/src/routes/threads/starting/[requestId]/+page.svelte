<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { applicationName } from "#lib/application-name.ts";
  import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
  import { threadCreations, startingPath, type ThreadCreation } from "#lib/features/threads/thread-creation.svelte.ts";
  import ThreadStartingScene from "#lib/features/threads/components/ThreadStartingScene.svelte";

  let job = $state<ThreadCreation>();

  $effect(() => {
    void webDrafts.generation;
    const requestId = page.params.requestId;

    if (webDrafts.ready && requestId) job = untrack(() => threadCreations.resume(requestId));
  });

  const snapshot = $derived(job?.snapshot);
  let opening = $state("");

  $effect(() => {
    const id = snapshot?.threadId;

    if (!id || !job?.current || opening === id || page.url.pathname !== startingPath(job.requestId)) return;
    untrack(() => job?.capture?.());
    opening = id;
    void goto(`/threads/${encodeURIComponent(id)}`, { replace: true }).catch(() => {});
  });
</script>

<svelte:head><title>Starting thread · {applicationName}</title></svelte:head>

{#if job}<ThreadStartingScene {job} />{/if}
