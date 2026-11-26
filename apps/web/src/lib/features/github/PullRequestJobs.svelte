<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import { checkLook, jobStepsProgress } from "@canopy/domain/github-pr";
  import CheckStateIcon from "./CheckStateIcon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { PullRequestPages } from "./pages.svelte.ts";
  import { isLinkedOffline } from "./presentation.ts";
  import PageControls from "./PageControls.svelte";
  import PullRequestLog from "./PullRequestLog.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import CiActions from "./CiActions.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { prCitation, prCheckFailed } from "@canopy/domain";

  let { snapshot, runId }: { snapshot: github.PullRequestSnapshot; runId: string } = $props();

  const id = $derived(snapshot.summary?.ref?.id ?? "");
  const headSha = $derived(snapshot.summary?.headSha ?? "");
  let selected = $state("");

  const pages = $derived(
    new PullRequestPages(
      (cursor, refresh) =>
        api.page(
          "jobs",
          github.PullRequestJobsPageSchema,
          create(github.PullRequestPageRequestSchema, {
            pullRequestId: id,
            headSha,
            resourceId: runId,
            cursor,
            refresh,
          }),
        ),
      `jobs:${snapshot.accountId}:${snapshot.accessRevision}:${id}:${headSha}:${runId}`,
    ),
  );

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());

    const unsubscribe = invalidations.subscribe(id, () => void target.invalidate(true));

    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        region?.checkVisibility() &&
        target.current?.jobs.some((job) => ["queued", "in_progress", "pending", "waiting"].includes(job.state))
      )
        void target.read();
    }, 15_000);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  });

  let region = $state<HTMLDivElement>();
</script>

<div bind:this={region} class="grid min-w-0 gap-2">
  {#if !pages.current && !pages.error}
    <div role="status" aria-label="Loading workflow jobs" class="grid gap-4 py-2">
      <Skeleton class="h-3 w-1/2" />
      <Skeleton class="h-3 w-2/3" />
      <Skeleton class="h-3 w-1/3" />
    </div>
  {/if}
  {#if pages.current?.run}<div class="flex min-w-0 items-center gap-2">
      <p class="min-w-0 truncate font-medium" title={pages.current.run.name}>{pages.current.run.name}</p>
      <p class="mr-auto shrink-0 text-zinc-500 dark:text-zinc-400">Attempt {pages.current.run.attempt}</p>
      <CiActions {snapshot} {runId} state={pages.current.run.state} />
    </div>{/if}
  {#if pages.current?.jobs.length}
    <ul role="list" aria-label="Workflow jobs" class="grid min-w-0 gap-1">
      {#each pages.current?.jobs ?? [] as job (job.id)}
        {@const look = checkLook(job.state)}
        {@const stepProgress = jobStepsProgress([job])}
        {@const stepPercent = stepProgress ? Math.round((stepProgress.done / stepProgress.total) * 100) : undefined}
        <li class="min-w-0">
          <div class="group/pr flex min-w-0 items-center gap-2">
            <span class="flex shrink-0" {@attach tooltip(look.label)}><CheckStateIcon {look} /></span>
            <div class="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2">
              <p class="line-clamp-2 min-w-0 flex-1 wrap-anywhere sm:line-clamp-1" title={job.name}>{job.name}</p>
              {#if stepProgress}<span class="shrink-0 font-mono text-xs/4 text-zinc-500 sm:leading-5 dark:text-zinc-400"
                  >{stepProgress.done}/{stepProgress.total} · {stepPercent}%</span
                >{/if}
            </div>
            <CiActions
              {snapshot}
              {runId}
              jobId={job.id}
              state={pages.current?.run?.state ?? job.state}
              name={job.name}
              url={job.url}
              quote={prCheckFailed(job.state)
                ? prCitation(snapshot, "job", job.id, `${job.name}: ${job.state}`, { url: job.url })
                : undefined}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={selected === job.id}
              onclick={() => (selected = selected === job.id ? "" : job.id)}>View logs</Button
            >
          </div>
          {#if selected === job.id}
            <PullRequestLog
              {snapshot}
              jobId={job.id}
              jobUrl={job.url}
              class="ms-3 mt-1 mb-2 border-s border-zinc-950/15 ps-3 dark:border-white/15"
            />
          {/if}
        </li>
      {/each}
    </ul>
  {:else if pages.current?.run && !pages.current.page?.detail}
    <p class="text-zinc-500 dark:text-zinc-400">No jobs to show.</p>
  {/if}
  <PageControls
    page={pages.current?.page}
    retryLabel="Retry jobs"
    offlineShown={isLinkedOffline(snapshot)}
    busy={pages.busy}
    error={pages.error ? "Could not load this workflow’s jobs." : ""}
    previous={pages.index ? () => pages.index-- : undefined}
    next={() => void pages.read(true)}
    retry={() => void pages.read(false, true)}
  />
</div>
