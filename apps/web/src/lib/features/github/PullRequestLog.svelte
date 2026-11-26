<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageControls from "./PageControls.svelte";
  import * as api from "./api.ts";
  import CitationActions from "./CitationActions.svelte";
  import CitationRegion from "./CitationRegion.svelte";
  import { prCitation } from "@canopy/domain";

  let {
    snapshot,
    jobId,
    jobUrl,
    class: className,
  }: { snapshot: github.PullRequestSnapshot; jobId: string; jobUrl: string; class?: ClassValue } = $props();

  const request = $derived(
    create(github.PullRequestPageRequestSchema, {
      pullRequestId: snapshot.summary?.ref?.id ?? "",
      headSha: snapshot.summary?.headSha ?? "",
      resourceId: jobId,
    }),
  );

  const pages = $derived.by(() => {
    const base = request;

    return new PullRequestPages((cursor, refresh) =>
      api.page(
        "log",
        github.PullRequestJobLogPageSchema,
        create(github.PullRequestPageRequestSchema, { ...base, cursor, refresh }),
      ),
    );
  });

  const quote = $derived(
    prCitation(snapshot, "log", jobId, pages.current?.text ?? "", {
      firstLine: pages.current?.firstLine,
      url: jobUrl,
    }),
  );

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());
  });
</script>

<section aria-label="Job log" class={["grid min-w-0 gap-2", className]}>
  {#if pages.current?.text.trim()}
    <p class="font-mono text-zinc-500 dark:text-zinc-400">Job {jobId} · line {pages.current.firstLine}</p>
    <CitationRegion {quote}
      ><pre
        class="max-h-56 scroll-stable overflow-auto rounded-lg bg-zinc-950/4 p-3 font-mono text-xs/5 select-text dark:bg-white/5">{pages
          .current.text}</pre>
      <CitationActions {quote} url={jobUrl} />
    </CitationRegion>
  {:else if !pages.current && !pages.error}
    <div role="status" aria-label="Loading job log" class="grid gap-2 py-2">
      <Skeleton class="h-3 w-2/3" />
      <Skeleton class="h-3 w-1/2" />
    </div>
  {:else if pages.current && !pages.current.page?.detail && !pages.error}
    <p class="text-zinc-500 dark:text-zinc-400">This job produced no log output.</p>
  {/if}
  <PageControls
    page={pages.current?.page}
    retryLabel="Retry log"
    busy={pages.busy}
    error={pages.error ? "Could not load this job’s log." : ""}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</section>
