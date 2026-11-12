<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ReviewForm from "./ReviewForm.svelte";
  import type { ReviewDraft } from "./review-draft.svelte.ts";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";

  let {
    snapshot,
    draft,
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    draft: ReviewDraft;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
</script>

<div
  class={[
    "sticky top-(--pr-chrome-height,0px) z-40 -mx-4 flex h-14 items-center justify-between gap-3 border-b border-divider bg-surface px-4 py-2 text-sm sm:text-xs",
    className,
  ]}
>
  <div role="status" class="flex min-w-0 items-center gap-2">
    <Icon name="chat-bubble-left" />
    {#if !draft.pages.length && !draft.error}<Skeleton class="h-5 w-32" />{:else}<span
        >{draft.error
          ? "Could not load review."
          : draft.pendingId
            ? `${draft.count} pending ${draft.count === 1 ? "comment" : "comments"}`
            : "No pending review"}</span
      >{/if}
  </div>
  <Button
    size="sm"
    variant="primary"
    disabled={draft.busy}
    onclick={async () => {
      await draft.read();
      if (!draft.error) open = true;
    }}>{draft.error ? "Retry" : "Review changes"}</Button
  >
</div>
<Dialog bind:open title="Review changes" size="lg">
  <ReviewForm {snapshot} {draft} ondone={() => (open = false)} />
</Dialog>
