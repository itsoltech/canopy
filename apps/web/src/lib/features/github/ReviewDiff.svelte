<script lang="ts">
  import type { github } from "@canopy/contracts";
  import { diffAnchors, diffRange, type DiffPoint, type DiffRange } from "@canopy/domain/diff-anchors";
  import Diff from "#lib/features/threads/components/Diff.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ReviewDraft } from "./review-draft.svelte.ts";
  import ReviewCommentComposer from "./ReviewCommentComposer.svelte";

  let {
    patch,
    file,
    snapshot,
    draft,
    historical,
    class: className,
  }: {
    patch: github.PullRequestDiff;
    file: github.PullRequestFile;
    snapshot: github.PullRequestSnapshot;
    draft: ReviewDraft;
    historical: boolean;
    class?: ClassValue;
  } = $props();

  let first = $state<DiffPoint>(),
    selection = $state<DiffRange>(),
    dragging = $state(false),
    extending = $state(false);

  let error = $state("");
  const anchors = $derived(diffAnchors(patch.patch));

  const editorAfter = $derived(
    selection && !dragging
      ? anchors.find((a) => (selection?.side === "LEFT" ? a.left : a.right) === selection?.line)?.index
      : undefined,
  );

  function pick(point: DiffPoint, extend: boolean, drag: boolean) {
    error = "";
    const extendRange = extend || extending;

    if (extendRange && first) {
      const range = diffRange(anchors, first, point);

      if (range) selection = range;
      else error = "Select a range within one diff hunk.";
      extending = false;
    } else {
      first = point;
      selection = diffRange(anchors, point, point);
    }

    dragging = drag && !extendRange;
  }

  function enter(point: DiffPoint) {
    if (dragging && first) {
      const range = diffRange(anchors, first, point);

      if (range) selection = range;
    }
  }
</script>

<svelte:window onpointerup={() => (dragging = false)} onpointercancel={() => (dragging = false)} />
<div class={["@container/review min-w-0", className]}>
  {#if historical}<p class="pb-2 text-sm text-zinc-500 sm:text-xs">
      Open All commits to comment on the current changes.
    </p>{/if}
  {#if extending}<p role="status" class="pb-2 text-sm sm:text-xs">Select the last line of the range.</p>{/if}
  {#if error}<p role="alert" class="pb-2 text-sm text-rose-700 sm:text-xs dark:text-rose-400">{error}</p>{/if}
  <Diff
    diff={patch.patch}
    label={file.path}
    toolbar={false}
    bounded={false}
    review={historical ? undefined : { selection, onstart: pick, onenter: enter, editorAfter, editor }}
  />
  {#snippet editor()}
    {#if selection}{#key `${snapshot.accountId}:${file.path}:${patch.page?.headSha}`}
        <ReviewCommentComposer
          class="w-[100cqi] max-w-full"
          {snapshot}
          {file}
          range={selection}
          sha={patch.page?.headSha ?? ""}
          {draft}
          oncancel={() => {
            selection = undefined;
            first = undefined;
          }}
          onrange={() => (extending = true)}
        />
      {/key}{/if}
  {/snippet}
  {#if selection}<div class="flex justify-end py-1">
      <Button
        size="sm"
        variant="ghost"
        onclick={() => {
          selection = undefined;
          first = undefined;
        }}>Clear selection</Button
      >
    </div>{/if}
</div>
