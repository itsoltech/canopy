<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
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

  const id = $derived(snapshot.summary?.ref?.id ?? "");

  const pages = $derived(
    new PullRequestPages((cursor, refresh) =>
      api.page(
        "log",
        github.PullRequestJobLogPageSchema,
        create(github.PullRequestPageRequestSchema, { pullRequestId: id, resourceId: jobId, cursor, refresh }),
      ),
    ),
  );

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
  <p class="font-mono text-sm/5 text-zinc-500 sm:text-xs/5">Job {jobId} · line {pages.current?.firstLine ?? 1}</p>
  <CitationRegion {quote}
    ><pre
      class="max-h-96 scroll-stable overflow-auto rounded-lg bg-zinc-950/4 p-3 font-mono text-xs/5 select-text dark:bg-white/5">{pages
        .current?.text ?? ""}</pre>
    {#if quote.text}<CitationActions {quote} url={jobUrl} />{/if}
  </CitationRegion>
  <PageControls
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</section>
