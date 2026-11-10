<script lang="ts">
  import { untrack } from "svelte";
  import { browser } from "$app/env";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import {
    mutationRequest,
    sendMutation,
    mutationUnconfirmed,
    uncertainMutation,
  } from "@canopy/domain/github-mutations";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { mutations } from "./api.ts";
  import { invalidations } from "./invalidations.ts";
  import { mutationRefused } from "./mutation-errors.ts";
  import { commentDrafts } from "./comment-drafts.ts";

  let {
    snapshot,
    resourceId = "",
    commentKind = "",
    initial = "",
    ondone,
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    resourceId?: string;
    commentKind?: string;
    initial?: string;
    ondone?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const key = untrack(() => commentDrafts.key(snapshot, resourceId, commentKind));
  const saved = untrack(() => (browser ? commentDrafts.read(key, initial) : { body: initial, receipt: undefined }));
  let body = $state(saved.body);
  let preview = $state(false);
  let busy = $state(false);
  let receipt = $state<github.PullRequestMutationReceipt | undefined>(saved.receipt);
  let online = $state(true);
  const uncertain = $derived(receipt && mutationUnconfirmed(receipt));
  const ref = $derived(snapshot.summary?.ref);
  const action = $derived(commentKind ? "update_comment" : resourceId ? "reply" : "create_comment");
  const label = $derived(commentKind ? "Save comment" : resourceId ? "Reply" : "Post comment");

  $effect(() => commentDrafts.save(key, body, receipt));

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

  async function submit() {
    if (busy || uncertain || !online || snapshot.stale || !body.trim()) return;
    busy = true;
    const request = mutationRequest(snapshot, crypto.randomUUID(), action, { resourceId, commentKind, body });
    commentDrafts.pending(key, body, request);
    receipt = await sendMutation(mutations, request, mutationRefused);
    commentDrafts.save(key, receipt.state === "succeeded" ? "" : body, receipt);
    busy = false;

    if (receipt.state === "succeeded") {
      body = "";
      invalidations.publish(ref?.id ?? "");
      ondone?.();
    }
  }
</script>

<form
  class={["grid min-w-0 gap-3 rounded-lg border border-zinc-950/10 p-3 dark:border-white/10", className]}
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
>
  <div class="flex min-w-0 items-center justify-between gap-2 text-sm/5 sm:text-xs/5">
    <p
      class="min-w-0 truncate text-zinc-500 dark:text-zinc-400"
      title={`${snapshot.viewerLogin} · ${ref?.repositoryName} #${ref?.number}`}
    >
      {snapshot.viewerLogin} · {ref?.repositoryName} #{ref?.number}
    </p>
    <Button size="sm" variant="ghost" aria-pressed={preview} onclick={() => (preview = !preview)}
      >{preview ? "Write" : "Preview"}</Button
    >
  </div>
  {#if preview}<div class="min-h-24 min-w-0 [&>div]:[overflow-wrap:anywhere]">
      {#if body}<Markdown text={body} class="min-w-0" />{:else}<p class="text-sm text-zinc-500">
          Nothing to preview
        </p>{/if}
    </div>
  {:else}<Textarea
      name="comment"
      aria-label={resourceId ? "Reply or edit comment" : "Comment"}
      placeholder="Write a comment in Markdown…"
      rows={4}
      bind:value={body}
      disabled={busy || uncertain}
    />{/if}
  {#if uncertain}<p role="status" class="text-sm text-amber-700 dark:text-amber-400">
      {uncertainMutation}.
      <a
        class="underline"
        target="_blank"
        rel="noreferrer"
        href={`https://github.com/${ref?.repositoryName}/pull/${ref?.number}`}>Open on GitHub</a
      >
    </p>
  {:else if receipt?.state === "failed"}<p role="alert" class="text-sm text-rose-700 dark:text-rose-400">
      {receipt.detail}
    </p>
  {:else if receipt?.state === "succeeded"}<p role="status" class="text-sm text-zinc-500">Comment saved</p>{/if}
  {#if !online || snapshot.stale}<p role="status" class="text-sm text-zinc-500">
      Connect and refresh before sending. Your draft stays here.
    </p>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    {#if uncertain}<Button
        size="sm"
        variant="ghost"
        onclick={() => {
          receipt = undefined;
          body = "";
        }}>{commentKind ? "Edit again" : resourceId ? "Start a new reply" : "Start a new comment"}</Button
      >{/if}
    {#if ondone}<Button size="sm" variant="ghost" onclick={ondone}>Cancel</Button>{/if}
    <Button
      type="submit"
      size="sm"
      variant={resourceId ? "secondary" : "primary"}
      loading={busy}
      disabled={!online || snapshot.stale || uncertain || !body.trim()}>{label}</Button
    >
  </div>
</form>
