<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import { activityFilters, pullRequestActivity } from "@canopy/domain/github-read";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import GitHubAvatar from "./GitHubAvatar.svelte";
  import ReviewThread from "./ReviewThread.svelte";
  import TimelineEvent from "./TimelineEvent.svelte";
  import PageStatus from "./PageStatus.svelte";
  import { PullRequestPages } from "./pages.svelte.ts";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";

  let {
    id,
    snapshot,
    class: className,
  }: { id: string; snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();

  let kind = $state("");
  let oldest = $state(false);
  const includeThreads = $derived(!kind || kind === "review");

  const pages = $derived.by(() => {
    const base = create(github.PullRequestPageRequestSchema, { pullRequestId: id, kind, oldestFirst: oldest });

    return new PullRequestPages((cursor, refresh) =>
      api.page(
        "timeline",
        github.PullRequestTimelinePageSchema,
        create(github.PullRequestPageRequestSchema, { ...base, cursor, refresh }),
      ),
    );
  });

  const reviews = $derived(
    new PullRequestPages((cursor, refresh) =>
      api.page(
        "reviews",
        github.PullRequestReviewThreadsPageSchema,
        create(github.PullRequestPageRequestSchema, { pullRequestId: id, cursor, refresh }),
      ),
    ),
  );

  const rows = $derived(
    pullRequestActivity(
      pages.pages.flatMap((p) => p.items),
      includeThreads ? reviews.pages.flatMap((p) => p.threads) : [],
      oldest,
    ),
  );

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());

    const unsubscribe = invalidations.subscribe(id, () => void target.invalidate());
    const reviewUnsubscribe = invalidations.subscribe(`${id}:reviews`, () => void target.invalidate());

    return () => {
      unsubscribe();
      reviewUnsubscribe();
    };
  });

  $effect(() => {
    const target = reviews;
    untrack(() => void target.read());

    const unsubscribe = invalidations.subscribe(id, () => void target.invalidate());
    const reviewUnsubscribe = invalidations.subscribe(`${id}:reviews`, () => void target.invalidate());

    return () => {
      unsubscribe();
      reviewUnsubscribe();
    };
  });

  async function more() {
    if (pages.current?.page?.nextCursor) await pages.read(true);

    if (includeThreads && reviews.current?.page?.nextCursor) await reviews.read(true);
  }
</script>

<section aria-label="Timeline" class={["min-w-0", className]}>
  <div
    class="sticky top-0 z-20 flex h-12 items-center justify-between gap-2 border-b border-zinc-950/10 bg-surface dark:border-white/10"
  >
    <DropdownMenu label="Activity filter" sheet>
      {#snippet trigger(props)}<Button {...props} size="sm" variant="ghost"
          ><Icon name="funnel" /><span>{activityFilters.find((f) => f.value === kind)?.label}</span><Icon
            name="chevron-down"
            size="sm"
          /></Button
        >{/snippet}
      {#each activityFilters as filter (filter.value)}<MenuCheckItem
          checked={kind === filter.value}
          onselect={() => (kind = filter.value)}>{filter.label}</MenuCheckItem
        >{/each}
    </DropdownMenu>
    <IconButton
      size="sm"
      icon={oldest ? "arrow-up" : "arrow-down"}
      label={oldest ? "Oldest first" : "Newest first"}
      aria-pressed={oldest}
      onclick={() => (oldest = !oldest)}
    />
  </div>
  <ol
    role="list"
    class="relative grid gap-5 py-5 before:absolute before:inset-y-5 before:left-4 before:w-px before:bg-zinc-950/10 dark:before:bg-white/10"
  >
    {#each rows as row (row.key)}
      {@const author = row.kind === "thread" ? row.thread.comments[0]?.author : row.items[0]?.content.value?.author}
      <li class="relative flex min-w-0 items-start gap-3">
        <GitHubAvatar userId="" login={author ?? ""} class="ring-4 ring-surface" />
        <div class="min-w-0 flex-1 pt-1.5">
          {#if row.kind === "thread"}<ReviewThread {id} {snapshot} thread={row.thread} />{:else}<TimelineEvent
              items={row.items}
              {snapshot}
            />{/if}
        </div>
      </li>
    {/each}
  </ol>
  {#if pages.current && !rows.length}<p class="py-4 text-sm text-zinc-500">No matching activity</p>{/if}
  {#if pages.current?.page?.nextCursor || (includeThreads && reviews.current?.page?.nextCursor)}<Button
      variant="ghost"
      size="sm"
      disabled={pages.busy || reviews.busy}
      onclick={more}>Show more activity</Button
    >{/if}
  <PageStatus
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    retry={() => void pages.read(false, true)}
  />
  {#if includeThreads}<PageStatus
      page={reviews.current?.page}
      busy={reviews.busy}
      error={reviews.error}
      retry={() => void reviews.read(false, true)}
    />{/if}
</section>
