<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { anchorLabel } from "@canopy/domain/github-review";
  import Markdown from "./GitHubMarkdown.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CommentActions from "./CommentActions.svelte";
  import type { ReviewDraft } from "./review-draft.svelte.ts";
  import { prCommentCitation } from "@canopy/domain";
  import CitationRegion from "./CitationRegion.svelte";

  let {
    snapshot,
    draft,
    class: className,
  }: { snapshot: github.PullRequestSnapshot; draft: ReviewDraft; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 gap-3", className]}>
  <p class="text-sm font-medium">{draft.count} pending {draft.count === 1 ? "comment" : "comments"}</p>
  {#each draft.pages.flatMap((p) => p.comments) as item (item.comment?.id)}
    {#if item.comment}<CitationRegion quote={prCommentCitation(snapshot, item.comment, "review_comment", item)}
        ><div class="grid min-w-0 gap-2 rounded-md border border-divider p-3">
          <p class="text-sm wrap-anywhere sm:text-xs">
            <span class="font-mono">{item.path} · {anchorLabel(item)}</span>{#if item.outdated}<span
                class="ml-2 text-amber-700 dark:text-amber-400">Outdated · {item.comment?.sha.slice(0, 7)}</span
              >{/if}
          </p>
          <Markdown
            text={item.comment?.body ?? ""}
            pullRequestId={snapshot.summary?.ref?.id ?? ""}
            contentId={item.comment?.id ?? ""}
          />
          <CommentActions
            {snapshot}
            comment={item.comment}
            kind="review"
            quote={prCommentCitation(snapshot, item.comment, "review_comment", item)}
          />
        </div></CitationRegion
      >{/if}
  {/each}
  {#if draft.error}<p role="alert" class="text-sm text-rose-700 dark:text-rose-400">{draft.error}</p>{/if}
  {#if draft.pages.at(-1)?.page?.nextCursor}<Button
      size="sm"
      variant="ghost"
      loading={draft.busy}
      onclick={() => void draft.read(true)}>Load more pending comments</Button
    >{/if}
  {#if draft.pendingId && !draft.complete}<p class="text-sm text-zinc-500 dark:text-zinc-400">
      Load and check all pending comments before submitting.
    </p>{/if}
</div>
