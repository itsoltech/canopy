<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { copyJobAmounts, copyJobPercent, copyJobRunning } from "@canopy/domain/workspace-copy-jobs";
  import Button from "#lib/shared/ui/Button.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
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

<div class="grid min-w-0 gap-2 p-3">
  <div class="grid min-w-0 gap-0.5">
    <h2 class="truncate text-base/6 font-medium sm:text-sm/5" title={job.name}>
      {job.status === "failed"
        ? "Copy failed"
        : job.status === "completed"
          ? "Workspace copied"
          : `Copying ${job.name}`}
    </h2>
    <p class="truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400" title="{job.parentPath}/{job.name}">
      To {job.targetName || "worker"}{running ? "" : ` · ${job.name}`}
    </p>
  </div>
  {#if running}
    <ProgressBar value={copyJobPercent(job)} label="Copy progress" class="my-1" />
  {/if}
  {#if job.progress?.totalFiles || (running && job.status !== "waiting" && !job.progress?.currentFile && !error)}
    <p class="text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">{copyJobAmounts(job)}</p>
  {/if}
  {#if job.status === "failed" || error}
    <p role="alert" class="text-sm/5 text-rose-700 select-text sm:text-xs/5 dark:text-rose-400">{error || job.error}</p>
  {:else if job.status === "waiting"}
    <p role="status" class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      {job.error || "Both workers must be online. The copy continues when they are."}
    </p>
  {:else if running && job.progress?.currentFile}
    <p class="flex min-w-0 font-mono text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <MiddleTruncatedText text={job.progress.currentFile} />
    </p>
  {/if}
  <div class="flex justify-end gap-2 pt-1">
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
