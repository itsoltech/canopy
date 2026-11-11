<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { DiffRange } from "@canopy/domain/diff-anchors";
  import { anchorLabel } from "@canopy/domain/github-review";
  import {
    mutationRequest,
    sendMutation,
    mutationUnconfirmed,
    uncertainMutation,
  } from "@canopy/domain/github-mutations";
  import type { ClassValue } from "svelte/elements";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { commentDrafts } from "./comment-drafts.ts";
  import { mutations } from "./api.ts";
  import { mutationRefused, mutationDetail } from "./mutation-errors.ts";
  import { invalidations } from "./invalidations.ts";
  import type { ReviewDraft } from "./review-draft.svelte.ts";

  let {
    snapshot,
    file,
    range,
    sha,
    draft,
    oncancel,
    onrange,
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    file: github.PullRequestFile;
    range: DiffRange;
    sha: string;
    draft: ReviewDraft;
    oncancel: () => void;
    onrange: () => void;
    class?: ClassValue;
  } = $props();

  const key = untrack(() => commentDrafts.key(snapshot, `${file.path}:${sha}`, "inline"));
  const saved = untrack(() => commentDrafts.read(key, ""));

  let body = $state(saved.body),
    busy = $state(false),
    preview = $state(false),
    online = $state(true);

  let receipt = $state(saved.receipt);
  const uncertain = $derived(receipt && mutationUnconfirmed(receipt));
  const stale = $derived(snapshot.stale || sha !== snapshot.summary?.headSha);

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

  async function submit(singleComment: boolean) {
    if (busy || uncertain || !online || stale || !body.trim() || !draft.pages.length || draft.error) return;
    busy = true;

    const r = mutationRequest(snapshot, crypto.randomUUID(), "add_review_comment", {
      ...range,
      body,
      path: file.path,
      commitSha: sha,
      sourcePage: file.sourcePage,
      resourceId: singleComment ? "" : draft.pendingId,
      singleComment,
    });

    commentDrafts.pending(key, body, r);
    receipt = await sendMutation(mutations, r, mutationRefused, mutationDetail);
    commentDrafts.save(key, receipt.state === "succeeded" ? "" : body, receipt);

    if (receipt.state === "succeeded") {
      body = "";
      await draft.read();
      invalidations.publish(`${draft.id}:reviews`);
    }

    busy = false;
  }
</script>

<div class={["grid min-w-0 gap-3 border-y border-sky-500/30 bg-surface p-3 text-sm sm:text-xs", className]}>
  <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <p class="min-w-0 truncate font-mono" title={file.path}>{file.path} · {anchorLabel(range)} · {sha.slice(0, 7)}</p>
    <Button size="sm" variant="ghost" onclick={onrange}>Extend range</Button>
  </div>
  <p class="text-zinc-500 dark:text-zinc-400">
    {snapshot.viewerLogin} · {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number}
  </p>
  {#if preview}<Markdown text={body || "Nothing to preview"} />{:else}<Textarea
      name="inline-comment"
      aria-label="Inline comment"
      placeholder="Write a comment in Markdown…"
      bind:value={body}
      rows={3}
      resize={false}
      class="field-sizing-content max-h-80 min-h-24"
      disabled={busy || uncertain}
    />{/if}
  {#if receipt?.detail || (uncertain && !busy)}<p role="status" class="text-amber-700 dark:text-amber-400">
      {receipt?.detail || uncertainMutation}
      {#if uncertain}<a
          class="underline"
          href={`https://github.com/${snapshot.summary?.ref?.repositoryName}/pull/${snapshot.summary?.ref?.number}/files`}
          target="_blank"
          rel="noreferrer">Open on GitHub</a
        >{/if}
    </p>{/if}
  {#if receipt?.state === "succeeded"}<p role="status">
      {receipt.action === "add_review_comment" ? "Comment saved" : "Review saved"}
    </p>{/if}
  {#if stale || !online}<p role="status">
      Connect and open the current changes before sending. Your draft stays here.
    </p>{/if}
  {#if draft.pendingId}<p class="text-zinc-500 dark:text-zinc-400">
      A pending review exists. Add this comment to it, then submit the review.
    </p>{/if}
  {#if draft.error}<p role="alert">{draft.error}</p>
    <Button size="sm" variant="ghost" onclick={() => void draft.read()}>Refresh review</Button>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <Button size="sm" variant="ghost" onclick={() => (preview = !preview)}>{preview ? "Write" : "Preview"}</Button>
    <Button size="sm" variant="ghost" onclick={oncancel}>Cancel</Button>
    {#if uncertain}<Button
        size="sm"
        variant="ghost"
        onclick={() => {
          receipt = undefined;
          body = "";
        }}>Start a new comment</Button
      >{/if}
    <Button
      size="sm"
      disabled={busy ||
        uncertain ||
        !online ||
        stale ||
        !body.trim() ||
        !!draft.pendingId ||
        !draft.pages.length ||
        !!draft.error}
      onclick={() => void submit(true)}>Add single comment</Button
    >
    <Button
      size="sm"
      variant="primary"
      loading={busy}
      disabled={uncertain || !online || stale || !body.trim() || !draft.pages.length || !!draft.error}
      onclick={() => void submit(false)}>Add to review</Button
    >
  </div>
</div>
