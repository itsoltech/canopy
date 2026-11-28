<script lang="ts">
  import { untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { copySize } from "@canopy/domain/workspace-copy";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import MoveNotes from "#lib/features/computers/MoveNotes.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import {
    getTransfer,
    previewTransfer,
    startTransfer,
    transferFinished,
    transferStatus,
    transferSummary,
    transferTargets,
  } from "../thread-transfer.ts";

  /**
   * "Move to another worker…" (docs/thread-transfers.md): choose a worker of this gateway, see what moves along,
   * pick local files to take, then follow the move. The move continues if the dialog closes.
   */
  let { open = $bindable(false), thread }: { open?: boolean; thread: ui.Thread | undefined } = $props();

  const overview = useOverview();
  const targets = $derived(thread ? transferTargets(overview.ownWorkers, thread.workerId) : []);
  let target = $state<string>();
  let workspace = $state<string>();
  let preview = $state.raw<ui.ThreadTransferPreview>();
  let loading = $state(false);
  let starting = $state(false);
  let error = $state("");
  let chosen = $state<Record<string, boolean>>({});
  let secretsConfirmed = $state(false);
  let transfer = $state.raw<ui.ThreadTransfer>();
  const targetName = $derived(overview.worker(target ?? "")?.name ?? "the other worker");

  const workspaceOptions = $derived(
    (preview?.workspaceIds ?? []).flatMap((id) => {
      const found = overview.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);

      return found
        ? [{ value: id, label: found.label || found.rootPath, description: found.rootPath, icon: "folder" as const }]
        : [];
    }),
  );

  const localFiles = $derived(preview?.localFiles.filter((f) => chosen[f.path]) ?? []);
  const secrets = $derived(localFiles.filter((f) => f.secret));
  const ready = $derived(Boolean(preview && !preview.blocked && workspace && (!secrets.length || secretsConfirmed)));
  const running = $derived(Boolean(transfer && !transferFinished(transfer)));

  $effect(() => {
    if (!open) return;
    untrack(() => {
      target = targets.find((t) => !t.disabled)?.value;
      preview = undefined;
      transfer = undefined;
      error = "";
    });
  });

  // The preview follows the chosen worker; local configuration files start chosen.
  $effect(() => {
    const worker = target;
    const id = thread?.id;

    if (!open || !worker || !id || transfer) return;
    let current = true;
    loading = true;
    error = "";
    previewTransfer(id, worker)
      .then((result) => {
        if (!current) return;
        preview = result;
        workspace = result.workspaceIds[0];
        chosen = Object.fromEntries(result.localFiles.map((f) => [f.path, true]));
        secretsConfirmed = false;
      })
      .catch((cause) => {
        if (current) error = cause instanceof Error ? cause.message : "Could not check the move";
      })
      .finally(() => {
        if (current) loading = false;
      });

    return () => {
      current = false;
    };
  });

  $effect(() => {
    const id = transfer?.id;

    if (!open || !id || !running) return;

    const timer = setInterval(() => {
      void getTransfer(id)
        .then((next) => (transfer = next))
        .catch(() => {});
    }, 1000);

    return () => clearInterval(timer);
  });

  async function move() {
    if (!thread || !target || !workspace || !preview) return;
    starting = true;
    error = "";

    try {
      transfer = await startTransfer(thread.id, {
        workerId: target,
        workspaceId: workspace,
        localFiles: localFiles.map((f) => f.path),
        confirmedSecrets: secretsConfirmed ? secrets.map((f) => f.path) : [],
        expectedHead: preview.head,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not start the move";
    } finally {
      starting = false;
    }
  }
</script>

<Dialog
  bind:open
  size="lg"
  title={`Move “${thread?.title ?? ""}” to another worker`}
  description={transfer
    ? undefined
    : "The conversation, the agent's session and the thread's changes continue on the other worker, in a new worktree."}
>
  <div class="grid min-w-0 grid-cols-1 gap-5">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if transfer}
      <div class="grid min-w-0 grid-cols-1 gap-2">
        <p role="status" class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          {transferStatus(transfer, targetName)}{running ? " Moving continues if you close this window." : ""}
        </p>
        {#if running}<ProgressBar
            label="Moving the thread"
            value={transfer.totalBytes ? (Number(transfer.bytes) / Number(transfer.totalBytes)) * 100 : undefined}
          />{/if}
      </div>
      <DialogActions><Button onclick={() => (open = false)}>Close</Button></DialogActions>
    {:else}
      <Field label="Move to" description={targets.length ? undefined : "Connect another worker to this gateway first."}>
        <Select
          name="transfer-target"
          bind:value={target}
          options={targets}
          placeholder="Choose a worker…"
          disabled={!targets.length}
        />
      </Field>
      {#if loading}
        <div class="grid gap-2" aria-hidden="true"><Skeleton class="h-5 w-2/3" /><Skeleton class="h-5 w-1/2" /></div>
      {:else if preview?.blocked}
        <Alert tone="warning">{preview.blocked}</Alert>
      {:else if preview}
        {#if workspaceOptions.length > 1}
          <Field label="Workspace" description={`The new worktree is created in this checkout on ${targetName}.`}>
            <Select name="transfer-workspace" bind:value={workspace} options={workspaceOptions} />
          </Field>
        {/if}
        <MoveNotes
          title={preview.branch ? `Moves along, on branch ${preview.branch}` : "Moves along"}
          items={transferSummary(preview)}
        />
        {#if preview.localFiles.length}
          <div class="grid min-w-0 grid-cols-1 gap-2">
            <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">Local files</p>
            {#each preview.localFiles as file (file.path)}
              <Checkbox
                name="transfer-local-file"
                label={file.path}
                description={file.secret ? `May contain secrets · ${copySize(file.size)}` : copySize(file.size)}
                bind:checked={chosen[file.path]}
              />
            {/each}
            {#if secrets.length}
              <Checkbox
                name="transfer-secrets"
                label={`Copy ${secrets.length === 1 ? "this file" : `these ${secrets.length} files`} to ${targetName}`}
                description="They can contain passwords or keys."
                bind:checked={secretsConfirmed}
              />
            {/if}
          </div>
        {/if}
        <MoveNotes title={`To do again on ${targetName}`} items={preview.redo} />
      {/if}
      <DialogActions>
        <Button onclick={() => (open = false)}>Cancel</Button>
        <Button
          variant="primary"
          icon="arrows-right-left"
          disabled={!ready || loading}
          loading={starting}
          onclick={() => void move()}>Move</Button
        >
      </DialogActions>
    {/if}
  </div>
</Dialog>
