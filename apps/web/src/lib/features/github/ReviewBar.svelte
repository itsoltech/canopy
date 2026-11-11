<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ReviewForm from "./ReviewForm.svelte";
  import type { ReviewDraft } from "./review-draft.svelte.ts";

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
    "sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-divider bg-surface py-2 text-sm sm:text-xs",
    className,
  ]}
>
  <p role="status" class="flex min-w-0 items-center gap-2">
    <Icon name="chat-bubble-left" />
    <span
      >{draft.busy
        ? "Loading review…"
        : draft.pendingId
          ? `${draft.count} pending ${draft.count === 1 ? "comment" : "comments"}`
          : "No pending review"}</span
    >
  </p>
  <Button
    size="sm"
    variant="primary"
    disabled={draft.busy}
    onclick={async () => {
      await draft.read();
      open = true;
    }}>Review changes</Button
  >
</div>
<Dialog bind:open title="Review changes" size="lg">
  <ReviewForm {snapshot} {draft} ondone={() => (open = false)} />
</Dialog>
