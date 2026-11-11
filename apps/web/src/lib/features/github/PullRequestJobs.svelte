<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import { checkLook } from "@canopy/domain/github-pr";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageControls from "./PageControls.svelte";
  import PullRequestLog from "./PullRequestLog.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { toneClasses } from "./presentation.ts";

  let { id, runId, class: className }: { id: string; runId: string; class?: ClassValue } = $props();
  let selected = $state("");

  const pages = $derived(
    new PullRequestPages((cursor, refresh) =>
      api.page(
        "jobs",
        github.PullRequestJobsPageSchema,
        create(github.PullRequestPageRequestSchema, { pullRequestId: id, resourceId: runId, cursor, refresh }),
      ),
    ),
  );

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());

    const unsubscribe = invalidations.subscribe(id, () => void target.invalidate());

    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        target.current?.jobs.some((job) => ["queued", "in_progress", "pending", "waiting"].includes(job.state))
      )
        void target.read(false, true);
    }, 15_000);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  });
</script>

<div class={["grid min-w-0 gap-2 p-3", className]}>
  {#each pages.current?.jobs ?? [] as job (job.id)}
    {@const look = checkLook(job.state)}
    <div class="flex min-w-0 items-center gap-2 text-sm/5 sm:text-xs/5">
      <span {@attach tooltip(look.label)}
        ><Icon name={look.icon} label={look.label} tone="inherit" class={toneClasses[look.tone]} /></span
      >
      <p class="min-w-0 flex-1 truncate" title={job.name}>{job.name}</p>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={selected === job.id}
        onclick={() => (selected = selected === job.id ? "" : job.id)}>View logs</Button
      >
    </div>
    {#if selected === job.id}<PullRequestLog {id} jobId={job.id} />{/if}
  {/each}
  <PageControls
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</div>
