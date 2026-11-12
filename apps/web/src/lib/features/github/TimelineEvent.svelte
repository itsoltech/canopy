<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { timelineLook } from "@canopy/domain/github-pr";
  import { safeHref } from "@canopy/domain/markdown";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import ActivityHeader from "./ActivityHeader.svelte";
  import CommentActions from "./CommentActions.svelte";
  import CitationActions from "./CitationActions.svelte";
  import CitationRegion from "./CitationRegion.svelte";
  import { prCommentCitation } from "@canopy/domain";

  let {
    items,
    snapshot,
    class: className,
  }: { items: github.PullRequestTimelineItem[]; snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();

  const first = $derived(items[0]);
  const entry = $derived(first?.content.value);
  const look = $derived(entry && timelineLook(entry.kind, entry.state, first?.content.case));
</script>

<div class={["grid min-w-0 gap-2", className]}>
  {#if entry && look}
    <ActivityHeader author={entry.author} {look} time={entry.createdAt} url={entry.url} />
    {#if first?.content.case === "commit"}
      <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
        pushed {items.length}
        {items.length === 1 ? "commit" : "commits"}
      </p>
      <ul role="list" class="grid gap-1.5">
        {#each items as item (item.content.value?.id)}{@const commit = item.content.value}
          {#if commit}<li class="flex min-w-0 gap-2 text-sm sm:text-xs">
              <a
                href={safeHref(commit.url)}
                target="_blank"
                rel="noreferrer"
                class="shrink-0 rounded bg-zinc-500/5 px-1 font-mono text-zinc-500 hover:underline dark:text-zinc-400"
                >{commit.sha.slice(0, 7)}</a
              >
              <p class="min-w-0 truncate" title={commit.body}>{commit.body}</p>
            </li>{/if}
        {/each}
      </ul>
    {:else if first?.content.case === "event"}
      <p class="text-sm/5 break-words text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {look.label}{entry.body ? ` · ${entry.body}` : ""}
      </p>
    {:else}<CitationRegion quote={prCommentCitation(snapshot, entry, first?.content.case ?? "comment")}
        ><div
          class="min-w-0 rounded-lg border border-zinc-950/10 bg-zinc-500/3 p-3 dark:border-white/10 dark:bg-white/3 [&>div]:[overflow-wrap:anywhere]"
        >
          <Markdown text={entry.body} class="min-w-0" />
          {#if first?.content.case === "comment"}<CommentActions
              {snapshot}
              comment={entry}
              kind="issue"
              quote={prCommentCitation(snapshot, entry)}
            />
          {:else}<CitationActions quote={prCommentCitation(snapshot, entry, "review")} />{/if}
        </div></CitationRegion
      >{/if}
  {/if}
</div>
