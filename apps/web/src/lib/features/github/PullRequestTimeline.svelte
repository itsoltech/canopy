<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { timelineLook } from "@canopy/domain/github-pr";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { toneClasses } from "./presentation.ts";
  import { safeHref } from "@canopy/domain/markdown";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { formatDateTime } from "#lib/shared/format.ts";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageControls from "./PageControls.svelte";
  import PullRequestReviews from "./PullRequestReviews.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";

  let { id, class: className }: { id: string; class?: ClassValue } = $props();
  let kind = $state("");
  let author = $state("");
  let oldest = $state("newest");
  let reviews = $state(false);

  const pages = $derived.by(() => {
    const base = create(github.PullRequestPageRequestSchema, {
      pullRequestId: id,
      kind,
      author,
      oldestFirst: oldest === "oldest",
    });

    return new PullRequestPages((cursor, refresh) =>
      api.page(
        "timeline",
        github.PullRequestTimelinePageSchema,
        create(github.PullRequestPageRequestSchema, { ...base, cursor, refresh }),
      ),
    );
  });

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());

    return invalidations.subscribe(id, () => void target.invalidate());
  });
</script>

<section aria-label="Timeline" class={["grid min-w-0 gap-4", className]}>
  <div class="flex flex-wrap items-center gap-2">
    <Select
      aria-label="Timeline type"
      bind:value={kind}
      options={[
        { value: "", label: "All events" },
        { value: "comment", label: "Comments" },
        { value: "review", label: "Reviews" },
        { value: "commit", label: "Commits" },
        { value: "event", label: "Events" },
      ]}
    />
    <Select
      aria-label="Timeline order"
      bind:value={oldest}
      options={[
        { value: "newest", label: "Newest first" },
        { value: "oldest", label: "Oldest first" },
      ]}
    />
    <Input aria-label="Filter by author" placeholder="Author login" bind:value={author} />
  </div>
  <Button variant="ghost" aria-expanded={reviews} onclick={() => (reviews = !reviews)}
    >{reviews ? "Hide review threads" : "Review threads"}</Button
  >
  {#if reviews}<PullRequestReviews {id} />{/if}
  <ol role="list" class="grid gap-4">
    {#each pages.current?.items ?? [] as item, i (item.content.value?.id ?? i)}
      {@const entry = item.content.value}
      {#if entry}{@const look = timelineLook(entry.kind, entry.state, item.content.case)}
        <li class="grid min-w-0 gap-2 border-b border-zinc-950/5 pb-4 dark:border-white/10">
          <div class="flex min-w-0 items-center gap-2 text-sm/5 sm:text-xs/5">
            <span {@attach tooltip(look.label)} class={toneClasses[look.tone]}
              ><Icon name={look.icon} label={look.label} tone="inherit" /></span
            >
            <p class="min-w-0 flex-1 truncate font-medium">{entry.author}</p>
            <a
              href={safeHref(entry.url)}
              target="_blank"
              rel="noreferrer"
              class="shrink-0 text-zinc-500 hover:underline">{formatDateTime(entry.createdAt) || "Source"}</a
            >
          </div>
          {#if entry.body}<Markdown text={entry.body} />{/if}
          {#if entry.sha}<p class="font-mono text-sm text-zinc-500 sm:text-xs">{entry.sha.slice(0, 12)}</p>{/if}
        </li>{/if}
    {/each}
  </ol>
  {#if pages.current && !pages.current.items.length}<p class="text-sm text-zinc-500">
      No matching events on this page
    </p>{/if}
  <PageControls
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</section>
