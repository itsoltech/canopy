<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { create, type MessageInitShape } from "@bufbuild/protobuf";
  import { ui, type WorkspaceCopyManifest } from "@canopy/contracts";
  import { copyTree, copyTotals, copySize, copyFileCount } from "@canopy/domain/workspace-copy";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import FileTreePicker from "#lib/shared/ui/FileTreePicker.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import StepHeader from "./StepHeader.svelte";
  import { streamWorkspaceCopy } from "./workspace-copy.ts";

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
  let cancelled = $state(false);
  let progress = $state.raw<ui.WorkspaceCopyProgress>();
  let controller: AbortController | undefined;
  const roots = $derived(copyTree(manifest?.entries ?? []));
  const entries = $derived((manifest?.entries ?? []).filter((e) => selected.has(e.path)));
  const totals = $derived(copyTotals(entries));
  const metadataMissing = $derived(manifest?.entries.some((e) => e.metadata && (!selected.has(e.path) || e.blocked)));
  const secrets = $derived(entries.filter((e) => e.secret && !e.directory));
  const skipped = $derived((manifest?.entries ?? []).filter((e) => !e.directory && !selected.has(e.path)).length);
  const done = $derived(progress?.status === "completed");
  const percent = $derived(progress?.totalBytes ? Number((progress.bytes * 100n) / progress.totalBytes) : 0);

  const actionLabel = $derived(
    done
      ? "Done"
      : error || cancelled
        ? "Refresh file list"
        : confirming
          ? "Copy these files"
          : secrets.length
            ? "Review secrets"
            : "Copy workspace",
  );

  const disabledReason = $derived(
    done || error || cancelled
      ? undefined
      : loading
        ? "Reading the file list…"
        : confirming && !confirmed
          ? "Confirm that you want to copy these files."
          : metadataMissing
            ? "Include all Git metadata to copy this checkout."
            : !totals.files
              ? "Choose files to copy."
              : undefined,
  );

  function submit() {
    if (busy || disabledReason) return;

    if (done) onclose();
    else if (error || cancelled) void load();
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
    controller?.abort();
    void release();
  });

  async function release() {
    if (manifest)
      await requestJson("DELETE", `/api/workspaces/${encodeURIComponent(workspace.id)}/copy-manifest`, {
        token: manifest.token,
      }).catch(() => {});
  }

  async function load() {
    await release();
    loading = true;
    error = "";
    confirming = false;
    confirmed = false;
    cancelled = false;
    progress = undefined;

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
      selected = new Set(manifest?.entries.filter((e) => e.included).map((e) => e.path));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not read the file list. Retry.";
    } finally {
      loading = false;
    }
  }

  async function copy() {
    if (!manifest || busy) return;

    if (secrets.length && !confirmed) {
      confirming = true;

      return;
    }

    controller = new AbortController();
    busy = true;
    onbusy(true);
    error = "";

    const input: MessageInitShape<typeof ui.CopyWorkspaceRequestSchema> = {
      sourceRef: workspace.id,
      targetRef: worker.id,
      projectRef: project.id,
      manifestToken: manifest.token,
      paths: [...selected],
      confirmedSecrets: confirmed ? secrets.map((e) => e.path) : [],
      parentPath: parent,
      name,
      transferKey: crypto.randomUUID(),
    };

    try {
      await streamWorkspaceCopy(
        create(ui.CopyWorkspaceRequestSchema, input),
        controller.signal,
        (event) => (progress = event),
      );
    } catch (cause) {
      if (controller.signal.aborted) cancelled = true;
      else error = cause instanceof Error ? cause.message : "Workspace copy failed. Refresh the file list and retry.";
    } finally {
      busy = false;
      onbusy(false);
    }
  }
</script>

<svelte:window {onkeydown} />

<StepHeader
  onback={!busy && !done
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
  {disabledReason}
  busy={busy || loading}
>
  <h2 class="min-w-0 flex-1 truncate py-3 font-medium" title={name}>
    {done
      ? "Workspace copied"
      : busy
        ? "Copying workspace"
        : error
          ? "Copy failed"
          : cancelled
            ? "Copy cancelled"
            : confirming
              ? "Copy files that may contain secrets?"
              : "Choose files to copy"}
  </h2>
</StepHeader>
<div class="flex min-h-0 scroll-stable flex-col gap-3 overflow-y-auto p-4 text-base/6 sm:text-sm/5">
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
  {:else if busy}
    <p role="status">{progress?.status === "finishing" ? "Adding the workspace…" : "Copying files…"}</p>
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
    <Button onclick={() => controller?.abort()}>Cancel copy</Button>
  {:else if error || cancelled}
    <p role={error ? "alert" : "status"} class={error ? "text-rose-700 select-text dark:text-rose-400" : ""}>
      {error || "Copy cancelled. Partial files are removed automatically."}
    </p>
  {:else if confirming}
    <p>These files may contain passwords, tokens or private keys. Copy them only to a computer you trust.</p>
    <ul role="list" class="max-h-52 scroll-stable overflow-auto rounded-lg bg-zinc-950/3 p-3 dark:bg-white/5">
      {#each secrets as entry (entry.path)}<li class="font-mono break-all select-text">{entry.path}</li>{/each}
    </ul>
    <Checkbox
      name="confirm-copy-secrets"
      label="I want to copy these files to {worker.name}"
      bind:checked={confirmed}
    />
  {:else if manifest}
    <p class="text-zinc-500 dark:text-zinc-400">
      Git metadata preserves the branch and local changes. Ignored build files start excluded.
    </p>
    <FileTreePicker
      {roots}
      {selected}
      onchange={(next) => {
        selected = next;
        confirmed = false;
      }}
    />
    <p class="tabular-nums">
      {copyFileCount(totals.files)} · {copySize(totals.bytes)} selected · {skipped.toLocaleString()} skipped
    </p>
    <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
      Up to 20 GB in total, 8 GB per file. Your selection is remembered for this project.
    </p>
    {#if metadataMissing}
      <p role="status">
        Include all Git metadata to copy this checkout. Wait for Git operations to finish, then refresh.
      </p>
    {/if}
  {/if}
</div>
