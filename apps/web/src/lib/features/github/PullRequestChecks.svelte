<script lang="ts">
  import { plural } from "@canopy/domain/humanize";
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import {
    checkComplete,
    checksProgress,
    checksSummary,
    jobStepsProgress,
    sortedChecks,
  } from "@canopy/domain/github-pr";
  import Button from "#lib/shared/ui/Button.svelte";
  import { PullRequestPages } from "./pages.svelte.ts";
  import { readStatus, isLinkedOffline } from "./presentation.ts";
  import PageStatus from "./PageStatus.svelte";
  import PullRequestCheckRow from "./PullRequestCheckRow.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";
  import CiActions from "./CiActions.svelte";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let visible = $state(5);
  const id = $derived(snapshot.summary?.ref?.id ?? "");
  const headSha = $derived(snapshot.summary?.headSha ?? "");
  const cacheScope = $derived(`${snapshot.accountId}:${snapshot.accessRevision}:${id}:${headSha}`);

  const pages = $derived.by(() => {
    const base = create(github.PullRequestPageRequestSchema, {
      pullRequestId: id,
      headSha,
    });

    return new PullRequestPages(
      (cursor, refresh) =>
        api.page(
          "checks",
          github.PullRequestChecksPageSchema,
          create(github.PullRequestPageRequestSchema, { ...base, cursor, refresh }),
        ),
      `checks:${cacheScope}`,
    );
  });

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());

    const all = invalidations.subscribe(id, () => void target.invalidate(true));
    const resource = invalidations.subscribe(`${id}:checks`, () => void target.invalidate(true, false));

    return () => {
      all();
      resource();
    };
  });

  const checks = $derived(sortedChecks(pages.pages.length ? pages.pages.flatMap((p) => p.checks) : snapshot.checks));
  const runs = $derived([...new Set(checks.map((check) => check.runId).filter(Boolean))]);
  let jobs = $state<github.PullRequestJob[]>([]);
  let stepsPartial = $state(false);
  let stepsRequest = 0;

  async function more() {
    if (visible < checks.length) visible = checks.length;
    else {
      await pages.read(true);
      visible = checks.length;
    }
  }

  const summary = $derived(
    checksSummary(
      create(github.PullRequestSnapshotSchema, {
        ...snapshot,
        checks: pages.pages.length ? pages.pages.flatMap((p) => p.checks) : snapshot.checks,
      }),
    ),
  );

  const checkTotal = $derived(
    snapshot.completeness === "complete" && !pages.current?.page?.nextCursor
      ? checks.length
      : Math.max(checks.length, snapshot.summary?.checksCount ?? 0),
  );

  const checkProgress = $derived(checksProgress(checks, checkTotal));
  const stepProgress = $derived(stepsPartial ? undefined : jobStepsProgress(jobs));

  const checkPercent = $derived(
    checkProgress ? Math.round((checkProgress.done / checkProgress.total) * 100) : undefined,
  );

  const stepPercent = $derived(stepProgress ? Math.round((stepProgress.done / stepProgress.total) * 100) : undefined);

  async function loadStepProgress(runIds: readonly string[], refresh = false) {
    const request = ++stepsRequest;

    const responses = await Promise.allSettled(
      runIds.map(async (runId) => {
        const result: github.PullRequestJob[] = [];
        let cursor = "";

        for (let page = 0; page < 100; page++) {
          const response = await api.page(
            "jobs",
            github.PullRequestJobsPageSchema,
            create(github.PullRequestPageRequestSchema, {
              pullRequestId: id,
              resourceId: runId,
              headSha,
              cursor,
              refresh,
            }),
          );

          result.push(...response.jobs);
          cursor = response.page?.nextCursor ?? "";

          if (!cursor) return { jobs: result, complete: true };
        }

        return { jobs: result, complete: false };
      }),
    );

    if (request !== stepsRequest) return;

    jobs = responses.flatMap((response) => (response.status === "fulfilled" ? response.value.jobs : []));
    stepsPartial = responses.some(
      (response) => response.status === "rejected" || (response.status === "fulfilled" && !response.value.complete),
    );
  }

  $effect(() => {
    const runIds = runs;
    stepsRequest++;
    jobs = [];
    stepsPartial = false;

    if (!id || !runIds.length) {
      return;
    }

    void loadStepProgress(runIds);

    const timer = setInterval(() => {
      const running =
        checks.some((check) => !checkComplete(check.state)) || jobs.some((job) => !checkComplete(job.state));

      if (document.visibilityState === "visible" && running) void loadStepProgress(runIds, true);
    }, 15_000);

    return () => clearInterval(timer);
  });
</script>

<section aria-label="Checks" class={["grid min-w-0 gap-2", className]}>
  <div class="flex min-w-0 items-center justify-between gap-2 text-sm/5 sm:text-xs/5">
    <h3 class="min-w-0 font-medium">
      {summary}
      {#if checkProgress}<span class="font-mono text-zinc-500">
          · {checkProgress.done}/{plural(checkProgress.total, "check")} · {checkPercent}%</span
        >{/if}
      {#if stepProgress}<span class="font-mono text-zinc-500">
          · {stepProgress.done}/{plural(stepProgress.total, "step")} · {stepPercent}%</span
        >{/if}
    </h3>
    <p class="shrink-0 font-mono text-zinc-500" title={snapshot.summary?.headSha}>
      on {snapshot.summary?.headSha.slice(0, 7)}
    </p>
  </div>
  <ul
    role="list"
    class="max-h-96 min-w-0 scroll-stable divide-y divide-zinc-950/5 overflow-y-auto rounded-lg border border-zinc-950/10 dark:divide-white/5 dark:border-white/10"
  >
    {#each checks.slice(0, visible) as check (check.nodeId || `${check.runId}:${check.provider}:${check.name}`)}<PullRequestCheckRow
        {snapshot}
        {check}
      />{/each}
  </ul>
  {#each runs as runId (runId)}<CiActions {snapshot} {runId} state="unknown" dialog />{/each}
  {#if visible < checks.length || pages.current?.page?.nextCursor}<Button
      variant="ghost"
      size="sm"
      disabled={pages.busy}
      onclick={more}
      >{visible < checks.length ? `Show ${plural(checks.length - visible, "more check")}` : "Show more checks"}</Button
    >{/if}
  <PageStatus
    detail={readStatus(pages.current?.page, isLinkedOffline(snapshot))}
    retryLabel="Retry checks"
    busy={pages.busy}
    error={pages.error}
    retry={() => void pages.read(false, true)}
  />
</section>
