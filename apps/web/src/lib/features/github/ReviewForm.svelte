<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { reviewOutdated } from "@canopy/domain/github-review";
  import {
    mutationRequest,
    sendMutation,
    mutationUnconfirmed,
    uncertainMutation,
  } from "@canopy/domain/github-mutations";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { mutations } from "./api.ts";
  import { commentDrafts } from "./comment-drafts.ts";
  import { invalidations } from "./invalidations.ts";
  import { mutationRefused, mutationDetail } from "./mutation-errors.ts";
  import type { ReviewDraft } from "./review-draft.svelte.ts";
  import PendingComments from "./PendingComments.svelte";

  let {
    snapshot,
    draft,
    ondone,
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    draft: ReviewDraft;
    ondone: () => void;
    class?: ClassValue;
  } = $props();

  const key = untrack(() => commentDrafts.key(snapshot, draft.pendingId, "review-summary"));
  const saved = untrack(() => commentDrafts.read(key, draft.pages[0]?.body ?? ""));

  let body = $state(saved.body),
    verdict = $state("COMMENT"),
    busy = $state(false),
    preview = $state(false);

  let receipt = $state(saved.receipt),
    acknowledge = $state(false),
    online = $state(true),
    deleting = $state(false),
    error = $state("");

  let prepared = $state<github.PullRequestMutationRequest>();
  const uncertain = $derived(receipt && mutationUnconfirmed(receipt));
  const outdated = $derived(reviewOutdated(draft.pages, snapshot.summary?.headSha ?? ""));
  const own = $derived(draft.pages[0]?.viewerIsAuthor ?? true);
  const closed = $derived(!["open", "draft"].includes(snapshot.summary?.state ?? ""));
  const blocked = $derived(busy || !!uncertain || !online || snapshot.stale || closed || !draft.complete);

  const options = $derived([
    { value: "COMMENT", label: "Comment" },
    { value: "APPROVE", label: "Approve", disabled: own },
    { value: "REQUEST_CHANGES", label: "Request changes", disabled: own },
  ]);

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

  function request(action: string) {
    return mutationRequest(snapshot, crypto.randomUUID(), action, {
      resourceId: draft.pendingId,
      reviewRevision: draft.revision,
      body: action === "submit_review" ? body : "",
      verdict: action === "submit_review" ? verdict : "",
      acknowledgeOutdated: acknowledge,
    });
  }

  async function send(r: github.PullRequestMutationRequest) {
    busy = true;
    commentDrafts.pending(key, body, r);
    receipt = await sendMutation(mutations, r, mutationRefused, mutationDetail);
    commentDrafts.save(key, receipt.state === "succeeded" ? "" : body, receipt);
    deleting = false;

    if (receipt.state === "succeeded") {
      body = "";
      await draft.read();
      invalidations.publish(`${draft.id}:reviews`);
      ondone();
    }

    busy = false;
  }

  async function prepareDiscard() {
    if (blocked || !draft.pendingId) return;
    busy = true;
    error = "";

    try {
      const r = request("discard_review");
      const confirmation = await mutations.preparePullRequestMutation(r);
      prepared = { ...r, confirmationId: confirmation.confirmationId };
      deleting = true;
    } catch {
      error = "Could not prepare discarding this review. Refresh and check account access.";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <p class="text-sm text-zinc-500 dark:text-zinc-400">
    {snapshot.viewerLogin} · {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number} · {snapshot.summary?.headSha.slice(
      0,
      7,
    )}
  </p>
  <PendingComments {snapshot} {draft} />
  <div class="flex items-center justify-between gap-2">
    <label for="review-summary" class="text-sm font-medium">Summary</label><Button
      size="sm"
      variant="ghost"
      onclick={() => (preview = !preview)}>{preview ? "Write" : "Preview"}</Button
    >
  </div>
  {#if preview}<Markdown text={body || "Nothing to preview"} />{:else}<Textarea
      id="review-summary"
      name="review-summary"
      aria-label="Review summary"
      placeholder="Summarize your review in Markdown…"
      bind:value={body}
      rows={4}
      resize={false}
      class="field-sizing-content max-h-80 min-h-28"
      disabled={busy || uncertain}
    />{/if}
  <Select name="review-verdict" aria-label="Review verdict" {options} bind:value={verdict} disabled={blocked} />
  {#if own}<p class="text-sm text-zinc-500 dark:text-zinc-400">
      GitHub does not allow you to approve or request changes on your own pull request. Choose Comment.
    </p>{/if}
  {#if outdated}<Checkbox
      name="acknowledge-outdated"
      label="I checked the outdated comments against the current changes"
      bind:checked={acknowledge}
      disabled={busy || uncertain}
    />{/if}
  {#if closed || snapshot.stale || !online}<p role="status" class="text-sm text-zinc-500">
      {closed ? "This pull request is closed." : "Connect and refresh before submitting. Your draft stays here."}
    </p>{/if}
  {#if error || receipt?.detail || (uncertain && !busy)}<p
      role="alert"
      class="text-sm text-amber-700 dark:text-amber-400"
    >
      {error || receipt?.detail || uncertainMutation}
      {#if uncertain}<a
          class="underline"
          href={`https://github.com/${snapshot.summary?.ref?.repositoryName}/pull/${snapshot.summary?.ref?.number}/files`}
          target="_blank"
          rel="noreferrer">Open on GitHub</a
        >{/if}
    </p>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <Button
      size="sm"
      variant="ghost"
      disabled={busy || !!uncertain}
      onclick={() => {
        acknowledge = false;
        void draft.read();
      }}>Refresh review</Button
    >
    {#if draft.pendingId}<Button size="sm" variant="danger" disabled={blocked} onclick={() => void prepareDiscard()}
        >Discard review</Button
      >{/if}
    {#if uncertain}<Button
        size="sm"
        variant="ghost"
        onclick={() => {
          receipt = undefined;
          acknowledge = false;
          void draft.read();
        }}>Check current review</Button
      >{/if}
    <Button
      size="sm"
      variant="primary"
      loading={busy}
      disabled={blocked ||
        (outdated && !acknowledge) ||
        (own && verdict !== "COMMENT") ||
        (verdict === "COMMENT" && !body.trim() && !draft.count) ||
        (verdict === "REQUEST_CHANGES" && !body.trim())}
      onclick={() => void send(request("submit_review"))}>Submit review</Button
    >
  </div>
</div>
<Dialog
  bind:open={deleting}
  title="Discard review?"
  description={`Delete all ${draft.count} pending comments as ${snapshot.viewerLogin}. This cannot be undone.`}
>
  <DialogActions
    ><Button onclick={() => (deleting = false)}>Cancel</Button><Button
      variant="danger"
      loading={busy}
      onclick={() => prepared && void send(prepared)}>Discard review</Button
    ></DialogActions
  >
</Dialog>
