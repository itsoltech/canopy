<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { checksSummary, sortedChecks } from "@canopy/domain/github-pr";
  import Button from "#lib/shared/ui/Button.svelte";
  import { PullRequestPages } from "./pages.svelte.ts";
  import PageStatus from "./PageStatus.svelte";
  import PullRequestCheckRow from "./PullRequestCheckRow.svelte";
  import * as api from "./api.ts";
  import { invalidations } from "./invalidations.ts";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let visible = $state(5);
  const id = $derived(snapshot.summary?.ref?.id ?? "");
  const headSha = $derived(snapshot.summary?.headSha ?? "");

  const pages = $derived.by(() => {
    const base = create(github.PullRequestPageRequestSchema, {
      pullRequestId: id,
      headSha,
    });

    return new PullRequestPages((cursor, refresh) =>
      api.page(
        "checks",
        github.PullRequestChecksPageSchema,
        create(github.PullRequestPageRequestSchema, { ...base, cursor, refresh }),
      ),
    );
  });

  $effect(() => {
    const target = pages;
    untrack(() => void target.read());

    return invalidations.subscribe(id, () => void target.invalidate());
  });

  const checks = $derived(sortedChecks(pages.pages.length ? pages.pages.flatMap((p) => p.checks) : snapshot.checks));

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
</script>

<section aria-label="Checks" class={["grid min-w-0 gap-2", className]}>
  <div class="flex min-w-0 items-center justify-between gap-2 text-sm/5 sm:text-xs/5">
    <h3 class="font-medium">{summary}</h3>
    <p class="shrink-0 font-mono text-zinc-500" title={snapshot.summary?.headSha}>
      on {snapshot.summary?.headSha.slice(0, 7)}
    </p>
  </div>
  <ul
    role="list"
    class="max-h-96 min-w-0 scroll-stable divide-y divide-zinc-950/5 overflow-y-auto rounded-lg border border-zinc-950/10 dark:divide-white/5 dark:border-white/10"
  >
    {#each checks.slice(0, visible) as check, i (`${check.nodeId}:${check.name}:${i}`)}<PullRequestCheckRow
        {id}
        {check}
      />{/each}
  </ul>
  {#if visible < checks.length || pages.current?.page?.nextCursor}<Button
      variant="ghost"
      size="sm"
      disabled={pages.busy}
      onclick={more}
      >{visible < checks.length ? `Show ${checks.length - visible} more checks` : "Show more checks"}</Button
    >{/if}
  <PageStatus
    page={pages.current?.page}
    busy={pages.busy}
    error={pages.error}
    retry={() => void pages.read(false, true)}
  />
</section>
