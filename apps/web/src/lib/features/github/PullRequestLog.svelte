<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageControls from "./PageControls.svelte";
  import * as api from "./api.ts";

  let { id, jobId, class: className }: { id: string; jobId: string; class?: ClassValue } = $props();

  const pages = $derived(
    new PullRequestPages((cursor, refresh) =>
      api.page(
        "log",
        github.PullRequestJobLogPageSchema,
        create(github.PullRequestPageRequestSchema, { pullRequestId: id, resourceId: jobId, cursor, refresh }),
      ),
    ),
  );

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());
  });
</script>

<section aria-label="Job log" class={["grid min-w-0 gap-2", className]}>
  <p class="font-mono text-sm/5 text-zinc-500 sm:text-xs/5">Job {jobId} · line {pages.current?.firstLine ?? 1}</p>
  <pre
    class="max-h-96 scroll-stable overflow-auto rounded-lg bg-zinc-950/4 p-3 font-mono text-xs/5 select-text dark:bg-white/5">{pages
      .current?.text ?? ""}</pre>
  <PageControls
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</section>
