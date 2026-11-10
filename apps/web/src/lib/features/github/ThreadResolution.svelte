<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import {
    mutationRequest,
    sendMutation,
    mutationUnconfirmed,
    uncertainMutation,
  } from "@canopy/domain/github-mutations";
  import Button from "#lib/shared/ui/Button.svelte";
  import { mutations } from "./api.ts";
  import { mutationRefused, mutationDetail } from "./mutation-errors.ts";
  import { invalidations } from "./invalidations.ts";
  import { commentDrafts } from "./comment-drafts.ts";

  let {
    snapshot,
    thread,
    class: className,
  }: { snapshot: github.PullRequestSnapshot; thread: github.PullRequestReviewThread; class?: ClassValue } = $props();

  const key = untrack(() => commentDrafts.key(snapshot, thread.id, "resolve"));

  let receipt = $state(untrack(() => commentDrafts.read(key, "").receipt)),
    busy = $state(false),
    online = $state(true);

  const uncertain = $derived(receipt && mutationUnconfirmed(receipt));
  const allowed = $derived(thread.resolved ? thread.viewerCanUnresolve : thread.viewerCanResolve);

  $effect(() => commentDrafts.save(key, "", receipt));

  $effect(() => {
    const update = () => (online = navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });

  async function toggle() {
    if (busy || uncertain || snapshot.stale || !allowed || !online) return;
    busy = true;

    const request = mutationRequest(snapshot, crypto.randomUUID(), "resolve_thread", {
      resourceId: thread.id,
      resolved: !thread.resolved,
    });

    commentDrafts.pending(key, "", request);
    receipt = await sendMutation(mutations, request, mutationRefused, mutationDetail);
    commentDrafts.save(key, "", receipt);
    busy = false;

    if (receipt.state === "succeeded") invalidations.publish(`${request.pullRequestId}:reviews`);
  }
</script>

<div class={["grid gap-2", className]}>
  <div>
    <Button
      size="sm"
      variant="ghost"
      loading={busy}
      disabled={!allowed || snapshot.stale || uncertain || !online}
      onclick={() => void toggle()}>{thread.resolved ? "Unresolve conversation" : "Resolve conversation"}</Button
    >
  </div>
  {#if !allowed}<p class="text-sm text-zinc-500 sm:text-xs">
      GitHub does not allow you to change this conversation.
    </p>{/if}
  {#if !online}<p class="text-sm text-zinc-500 sm:text-xs">Connect before changing this conversation.</p>{/if}
  {#if receipt?.detail || (uncertain && !busy)}<p
      role="status"
      class="text-sm text-amber-700 sm:text-xs dark:text-amber-400"
    >
      {receipt?.detail || uncertainMutation}
      {#if uncertain}<a
          class="underline"
          href={`https://github.com/${snapshot.summary?.ref?.repositoryName}/pull/${snapshot.summary?.ref?.number}`}
          target="_blank"
          rel="noreferrer">Open on GitHub</a
        >{/if}
    </p>{/if}
</div>
