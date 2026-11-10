<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageControls from "./PageControls.svelte";
  import ReviewThread from "./ReviewThread.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";

  let { id, class: className }: { id: string; class?: ClassValue } = $props();

  const pages = $derived(
    new PullRequestPages((cursor, refresh) =>
      api.page(
        "reviews",
        github.PullRequestReviewThreadsPageSchema,
        create(github.PullRequestPageRequestSchema, { pullRequestId: id, cursor, refresh }),
      ),
    ),
  );

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());

    return invalidations.subscribe(id, () => void target.invalidate());
  });
</script>

<section aria-label="Review threads" class={["grid min-w-0 gap-3", className]}>
  {#each pages.current?.threads ?? [] as thread (thread.id)}<ReviewThread {id} {thread} />{/each}
  <PageControls
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</section>
