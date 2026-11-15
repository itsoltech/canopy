<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { copyJobAmounts, copyJobPercent, copyJobRunning } from "@canopy/domain/workspace-copy-jobs";
  import Button from "#lib/shared/ui/Button.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import { copyJobs } from "./copy-jobs.svelte.ts";

  /** A background copy's progress and its actions: Cancel while it runs; Retry and Dismiss after it failed. */
  let { job }: { job: ui.WorkspaceCopyJob } = $props();
  let pending = $state("");
  let error = $state("");
  const running = $derived(copyJobRunning(job));

  async function act(action: "cancel" | "retry" | "dismiss") {
    pending = action;
    error = "";

    try {
      await copyJobs[action](job.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not reach the gateway. Retry.";
    } finally {
      pending = "";
    }
  }
</script>

<div class="grid gap-3 p-4">
  <div class="grid gap-0.5">
    <h2 class="truncate font-medium" title={job.name}>
      {job.status === "failed"
        ? "Copy failed"
        : job.status === "completed"
          ? "Workspace copied"
          : `Copying ${job.name}`}
    </h2>
    <p class="truncate text-muted" title="{job.parentPath}/{job.name}">To {job.targetName || "worker"} · {job.name}</p>
  </div>
  {#if running}
    <ProgressBar value={copyJobPercent(job)} label="Copy progress" />
  {/if}
  <p class="text-muted tabular-nums">{copyJobAmounts(job)}</p>
  {#if job.status === "failed" || error}
    <p role="alert" class="text-rose-700 select-text dark:text-rose-400">{error || job.error}</p>
  {:else if job.status === "waiting"}
    <p role="status" class="text-muted">
      {job.error || "Both workers must be online. The copy continues when they are."}
    </p>
  {:else if running}
    <p class="truncate text-muted" title={job.progress?.currentFile}>
      {job.progress?.currentFile || "Preparing the destination…"}
    </p>
  {/if}
  <div class="flex justify-end gap-2">
    {#if running}
      <Button size="sm" loading={pending === "cancel"} disabled={!!pending} onclick={() => void act("cancel")}
        >Cancel copy</Button
      >
    {:else}
      <Button size="sm" disabled={!!pending} onclick={() => void act("dismiss")}>Dismiss</Button>
      {#if job.status === "failed"}
        <Button
          size="sm"
          variant="primary"
          loading={pending === "retry"}
          disabled={!!pending}
          onclick={() => void act("retry")}>Retry</Button
        >
      {/if}
    {/if}
  </div>
</div>
