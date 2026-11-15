<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { create, type MessageInitShape } from "@bufbuild/protobuf";
  import { ui, type WorkspaceCopyManifest } from "@canopy/contracts";
  import {
    copySelection,
    copySelectable,
    copyTotals,
    copySize,
    copyFileCount,
    copyUnavailableReason,
  } from "@canopy/domain/workspace-copy";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import WorkspaceCopyFiles from "./WorkspaceCopyFiles.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import StepHeader from "./StepHeader.svelte";
  import { copyJobRunning } from "@canopy/domain/workspace-copy-jobs";
  import { copyJobs } from "../copy-jobs.svelte.ts";

  let {
    project,
    worker,
    workspace,
    parent,
    name,
    onbusy,
    onback,
    onclose,
  }: {
    project: ui.Project;
    worker: ui.Worker;
    workspace: ui.Workspace;
    parent: string;
    name: string;
    onbusy: (value: boolean) => void;
    onback: () => void;
    onclose: () => void;
  } = $props();

  let manifest = $state.raw<WorkspaceCopyManifest>();
  let selected = $state.raw<ReadonlySet<string>>(new Set());
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let confirming = $state(false);
  let confirmed = $state(false);
  let jobId = $state("");
  let cancelling = $state(false);

  // The copy runs in the gateway: closing this dialog or reloading the page does not stop it.
  const job = $derived(jobId ? copyJobs.jobs.get(jobId) : undefined);
  const progress = $derived(job?.progress);
  const cancelled = $derived(job?.status === "cancelled");
  const running = $derived(!!job && copyJobRunning(job));
  const entries = $derived(copySelection(manifest?.entries ?? [], selected));
  const totals = $derived(copyTotals(entries));
  const secrets = $derived(entries.filter((e) => e.secret && !e.directory));
  const disabledReason = $derived(copyUnavailableReason(entries));

  const skipped = $derived(
    (manifest?.entries ?? []).filter((e) => copySelectable(e) && !e.directory && !selected.has(e.path)).length,
  );

  const done = $derived(job?.status === "completed");
  const ended = $derived(Boolean(error) || cancelled || job?.status === "failed");
  const percent = $derived(progress?.totalBytes ? Number((progress.bytes * 100n) / progress.totalBytes) : 0);

  const actionLabel = $derived(
    done
      ? "Done"
      : running
        ? "Run in background"
        : ended
          ? "Refresh file list"
          : confirming
            ? "Copy these files"
            : secrets.length
              ? "Review secrets"
              : "Copy workspace",
  );

  const actionDisabledReason = $derived(
    done || ended || running
      ? undefined
      : loading
        ? "Reading the file list…"
        : confirming && !confirmed
          ? "Confirm the files above to continue."
          : disabledReason || undefined,
  );

  function submit() {
    if (busy || actionDisabledReason) return;

    if (done || running) onclose();
    else if (ended) void load();
    else void copy();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing || event.key !== "Enter") return;

    if (event.target instanceof HTMLElement && event.target.closest("button, input, [role=tree]")) return;
    event.preventDefault();
    submit();
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    if (!jobId) void release();
  });

  async function release() {
    if (manifest)
      await requestJson("DELETE", `/api/workspaces/${encodeURIComponent(workspace.id)}/copy-manifest`, {
        token: manifest.token,
      }).catch(() => {});
  }

  async function load() {
    if (!jobId) await release();
    loading = true;
    error = "";
    confirming = false;
    confirmed = false;
    jobId = "";

    try {
      manifest = decode(
        ui.GetWorkspaceCopyManifestResponseSchema,
        await requestJson(
          "GET",
          `/api/workspaces/${encodeURIComponent(workspace.id)}/copy-manifest`,
          undefined,
          130_000,
        ),
      ).manifest;
      selected = new Set(manifest?.entries.filter((e) => copySelectable(e) && e.included).map((e) => e.path));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not read the file list. Retry.";
    } finally {
      loading = false;
    }
  }

  async function copy() {
    if (!manifest || busy || disabledReason) return;

    if (secrets.length && !confirmed) {
      confirming = true;

      return;
    }

    busy = true;
    onbusy(true);
    error = "";

    const input: MessageInitShape<typeof ui.CopyWorkspaceRequestSchema> = {
      sourceRef: workspace.id,
      targetRef: worker.id,
      projectRef: project.id,
      manifestToken: manifest.token,
      ignoredSelection: { paths: [...selected] },
      confirmedSecrets: confirmed ? secrets.map((e) => e.path) : [],
      parentPath: parent,
      name,
      transferKey: crypto.randomUUID(),
      targetName: worker.name,
    };

    try {
      // The gateway owns the file list from here on (and releases it).
      jobId = (await copyJobs.start(create(ui.CopyWorkspaceRequestSchema, input))).id;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Workspace copy failed. Refresh the file list and retry.";
    } finally {
      busy = false;
      onbusy(false);
    }
  }

  async function cancel() {
    cancelling = true;

    try {
      await copyJobs.cancel(jobId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not cancel the copy. Retry.";
    } finally {
      cancelling = false;
    }
  }
</script>

<svelte:window {onkeydown} />

<StepHeader
  onback={!busy && !running && !done
    ? () => {
        if (confirming) {
          confirming = false;
          confirmed = false;
        } else onback();
      }
    : undefined}
  {onclose}
  onsubmit={submit}
  {actionLabel}
  disabledReason={actionDisabledReason}
  busy={busy || loading || running}
>
  <h2 class="min-w-0 flex-1 truncate py-3 font-medium" title={name}>
    {done
      ? "Workspace copied"
      : busy || running
        ? "Copying workspace"
        : error || job?.status === "failed"
          ? "Copy failed"
          : cancelled
            ? "Copy cancelled"
            : confirming
              ? "Copy files that may contain secrets?"
              : "Choose files to copy"}
  </h2>
</StepHeader>
<div class="min-h-0 flex-1 scroll-stable overflow-y-auto p-4 text-base/6 sm:text-sm/5">
  <div class="flex flex-col gap-3">
    <p class="truncate text-sm text-zinc-500 sm:text-xs dark:text-zinc-400" title="{parent}/{name}">
      To {worker.name} · {name}
    </p>
    {#if loading}
      <p role="status">Reading the file list…</p>
    {:else if done}
      <p role="status">
        Copied {copyFileCount(progress?.files ?? 0)} ({copySize(progress?.bytes ?? 0n)}). Skipped {copyFileCount(
          skipped,
        )}.
      </p>
      <p class="text-zinc-500 dark:text-zinc-400">The workspace is ready for new threads.</p>
    {:else if busy || running}
      <p role="status">
        {job?.status === "finishing"
          ? "Adding the workspace…"
          : job?.status === "waiting"
            ? job.error
            : job?.status === "queued"
              ? "Starts when another copy ends."
              : "Copying files… It continues in the background if you close this dialog."}
      </p>
      <div
        role="progressbar"
        aria-label="Copy progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent}
        class="h-1.5 overflow-hidden rounded-full bg-zinc-950/8 dark:bg-white/10"
      >
        <div class="h-full w-(--copy-progress) bg-brand-600 dark:bg-brand-500" style:--copy-progress="{percent}%"></div>
      </div>
      <p class="tabular-nums">
        {copySize(progress?.bytes ?? 0n)} / {copySize(totals.bytes)} · {progress?.files ?? 0} / {totals.files.toLocaleString()}
        files
      </p>
      <p class="truncate text-zinc-500 dark:text-zinc-400" title={progress?.currentFile}>
        {progress?.currentFile || "Preparing the destination…"}
      </p>
    {:else if ended}
      <p role={cancelled ? "status" : "alert"} class={cancelled ? "" : "text-rose-700 select-text dark:text-rose-400"}>
        {error || job?.error || "Copy cancelled. Partial files are removed automatically."}
      </p>
    {:else if confirming}
      <p>These files may contain passwords, tokens or private keys. Copy them only to a computer you trust.</p>
      <ul role="list" class="max-h-52 scroll-stable overflow-auto rounded-lg bg-zinc-950/3 p-3 dark:bg-white/5">
        {#each secrets as entry (entry.path)}<li class="font-mono break-all select-text">{entry.path}</li>{/each}
      </ul>
    {:else if manifest}
      <WorkspaceCopyFiles
        {manifest}
        {selected}
        onchange={(next) => {
          selected = next;
          confirmed = false;
        }}
      />
      <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
        Up to 20 GB in total, 8 GB per file. Ignored file choices are remembered for this project.
      </p>
    {/if}
  </div>
</div>
<div
  class="sticky bottom-0 z-10 flex shrink-0 flex-col gap-3 border-t border-zinc-950/10 bg-white p-4 text-base/6 sm:text-sm/5 dark:border-white/10 dark:bg-zinc-900"
>
  {#if loading}
    <Button variant="primary" loading class="w-full">Reading file list…</Button>
  {:else if done}
    <Button variant="primary" class="w-full" onclick={onclose}>Done</Button>
  {:else if busy}
    <Button variant="primary" loading class="w-full">Starting the copy…</Button>
  {:else if running}
    <Button variant="primary" class="w-full" onclick={onclose}>Run in background</Button>
    <Button class="w-full" loading={cancelling} disabled={cancelling} onclick={() => void cancel()}>Cancel copy</Button>
  {:else if ended}
    <Button variant="primary" class="w-full" onclick={() => void load()}>Refresh file list</Button>
  {:else if manifest}
    {#if confirming}
      <Checkbox
        name="confirm-copy-secrets"
        label="I want to copy these files to {worker.name}"
        bind:checked={confirmed}
      />
      {#if !confirmed}<p id="copy-disabled-reason" class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
          Confirm the files above to continue.
        </p>{/if}
    {:else}
      <p class="tabular-nums">
        {copyFileCount(totals.files)} · {copySize(totals.bytes)} selected · {skipped.toLocaleString()} skipped
      </p>
    {/if}
    {#if disabledReason}<p
        id="copy-disabled-reason"
        role="status"
        class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400"
      >
        {disabledReason}
      </p>{/if}
    <Button
      variant="primary"
      class="w-full"
      disabled={Boolean(disabledReason) || (confirming && !confirmed)}
      aria-describedby={disabledReason || (confirming && !confirmed) ? "copy-disabled-reason" : undefined}
      onclick={submit}>{confirming ? "Copy these files" : secrets.length ? "Review secrets" : "Copy workspace"}</Button
    >
  {/if}
</div>
