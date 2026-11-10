<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import {
    mutationRequest,
    sendMutation,
    mutationUnconfirmed,
    uncertainMutation,
  } from "@canopy/domain/github-mutations";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CommentComposer from "./CommentComposer.svelte";
  import { mutations } from "./api.ts";
  import { invalidations } from "./invalidations.ts";
  import { mutationRefused } from "./mutation-errors.ts";
  import { safeHref } from "@canopy/domain/markdown";

  let {
    snapshot,
    comment,
    kind,
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    comment: github.PullRequestTimelineEntry;
    kind: string;
    class?: ClassValue;
  } = $props();

  let editing = $state(false),
    deleting = $state(false),
    busy = $state(false),
    error = $state("");

  let prepared = $state<github.PullRequestMutationRequest>();
  let receipt = $state<github.PullRequestMutationReceipt>();
  const own = $derived(comment.author.toLowerCase() === snapshot.viewerLogin.toLowerCase());

  async function prepareDelete() {
    if (busy || snapshot.stale) return;
    busy = true;
    error = "";

    try {
      const r = mutationRequest(snapshot, crypto.randomUUID(), "delete_comment", {
        resourceId: comment.id,
        commentKind: kind,
      });

      const value = await mutations.preparePullRequestMutation(r);
      prepared = { ...r, confirmationId: value.confirmationId };
      deleting = true;
    } catch {
      error = "Could not prepare deletion. Refresh and check account access.";
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!prepared || busy) return;
    busy = true;
    receipt = await sendMutation(mutations, prepared, mutationRefused);
    busy = false;
    deleting = false;

    if (receipt.state === "succeeded") invalidations.publish(prepared.pullRequestId);
  }
</script>

{#if own && (comment.viewerCanUpdate || comment.viewerCanDelete)}<div class={["grid gap-2", className]}>
    <div class="flex justify-end">
      <DropdownMenu label="Comment actions" sheet>
        {#snippet trigger(props)}<IconButton
            {...props}
            icon="ellipsis-horizontal"
            label="Comment actions"
            size="sm"
            disabled={busy || snapshot.stale || (receipt && mutationUnconfirmed(receipt))}
          />{/snippet}
        {#if comment.viewerCanUpdate}<MenuItem onselect={() => (editing = true)}>Edit comment</MenuItem>{/if}
        {#if comment.viewerCanDelete}<MenuItem onselect={() => void prepareDelete()}>Delete comment</MenuItem>{/if}
      </DropdownMenu>
    </div>
    {#if editing}<CommentComposer
        {snapshot}
        resourceId={comment.id}
        commentKind={kind}
        initial={comment.body}
        ondone={() => (editing = false)}
      />{/if}
    {#if error || receipt?.detail}<p role="status" class="text-sm text-rose-700 dark:text-rose-400">
        {error || (receipt && mutationUnconfirmed(receipt) ? uncertainMutation : receipt?.detail)}
        {#if receipt && mutationUnconfirmed(receipt)}<a
            href={safeHref(comment.url)}
            target="_blank"
            rel="noreferrer"
            class="underline">Open on GitHub</a
          >{/if}
      </p>{/if}
  </div>{/if}
<Dialog
  bind:open={deleting}
  title="Delete comment?"
  description={`Delete your comment on ${snapshot.summary?.ref?.repositoryName} #${snapshot.summary?.ref?.number} as ${snapshot.viewerLogin}. This cannot be undone.`}
>
  <DialogActions
    ><Button onclick={() => (deleting = false)}>Cancel</Button><Button
      variant="danger"
      loading={busy}
      onclick={() => void remove()}>Delete comment</Button
    ></DialogActions
  >
</Dialog>
