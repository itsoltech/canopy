<script lang="ts">
  import { untrack } from "svelte";
  import type { github, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { ciLabel, ciEffect, ciReason, ciActions, type CiAction } from "@canopy/domain/github-ci";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import CitationActions from "./CitationActions.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import ConfirmationCountdown from "./ConfirmationCountdown.svelte";
  import { ciController } from "./ci-controllers.ts";
  import { invalidations } from "./invalidations.ts";

  let {
    snapshot,
    runId,
    state: runState,
    jobId = "",
    name = "",
    dialog = false,
    quote,
    url = "",
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    runId: string;
    state: string;
    jobId?: string;
    name?: string;
    dialog?: boolean;
    quote?: ui.Quote;
    url?: string;
    class?: ClassValue;
  } = $props();

  const controller = $derived(ciController(snapshot, runId));
  let f = $state(untrack(() => controller.read()));

  let online = $state(true);

  const blocked = $derived(f.busy || !!(f.receipt && ["accepted", "uncertain", "in_flight"].includes(f.receipt.state)));

  $effect(() => {
    const target = controller;
    f = target.read();

    return target.subscribe(() => (f = target.read()));
  });

  $effect(() => {
    const update = () => (online = navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });

  const actions = $derived(runId ? ciActions(runState, !!jobId) : []);

  const reason = (action: CiAction) =>
    !online ? "Connect and refresh before changing CI." : ciReason(snapshot, runId, runState, action);

  async function choose(action: CiAction) {
    if (f.receipt) {
      controller.patch({ open: true });

      return;
    }

    await controller.choose(action, action === "job" ? jobId : "", action === "job" ? name : "");
  }

  function refresh() {
    invalidations.publish(snapshot.summary?.ref?.id ?? "");
  }

  async function confirm() {
    await controller.confirm();
    refresh();
  }
</script>

{#snippet items()}
  {#if f.receipt}<MenuItem icon="clock" onselect={() => controller.patch({ open: true })}>Check CI request</MenuItem
    >{/if}
  {#each actions as action (action)}<MenuItem
      icon={action === "cancel" ? "stop" : "arrow-path"}
      disabled={f.busy || blocked || !!reason(action)}
      description={reason(action) || undefined}
      onselect={() => void choose(action)}>{ciLabel(action)}</MenuItem
    >{/each}
{/snippet}

{#if !dialog}<div class={["flex shrink-0 justify-end", className]}>
    <CitationActions {quote} {url} label="Check actions" children={actions.length || f.receipt ? items : undefined} />
  </div>{/if}
{#if dialog}<Dialog
    bind:open={
      () => f.open,
      (value) => {
        if (!value) controller.patch({ open: false });
      }
    }
    title={f.receipt ? "CI request" : `${ciLabel(f.action)}?`}
    description={f.receipt
      ? "GitHub updates the checks as jobs are queued, running and completed."
      : ciEffect(f.action)}
    dismissible={!f.busy}
  >
    <div class="grid min-w-0 gap-2 text-sm/5">
      <p class="wrap-anywhere">{snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number}</p>
      <p class="wrap-anywhere">{f.run?.name ?? name} · run {runId} · attempt {f.run?.attempt ?? "…"}</p>
      {#if f.action === "job"}<p class="wrap-anywhere">{f.jobName} · job {f.jobId}</p>{/if}
      <p class="font-mono" title={snapshot.summary?.headSha}>{snapshot.summary?.headSha.slice(0, 7)}</p>
      {#if f.prepared}<ConfirmationCountdown expiresAt={f.expiresAt} />{/if}
      {#if f.detail}<p role="status" class="text-amber-700 dark:text-amber-400">{f.detail}</p>{/if}
    </div>
    <DialogActions>
      <Button
        variant="ghost"
        data-autofocus
        disabled={f.busy}
        onclick={() => {
          controller.patch({ open: false });
        }}>{f.receipt ? "Close" : f.action === "cancel" ? "Keep run" : "Cancel"}</Button
      >
      {#if f.receipt}
        <Button
          disabled={f.busy || !online}
          onclick={async () => {
            await controller.check();
            refresh();
          }}>Check current state</Button
        >
      {:else}<Button
          variant={f.action === "cancel" ? "danger" : "primary"}
          loading={f.busy}
          disabled={!f.prepared || !online || snapshot.stale}
          onclick={() => void confirm()}>{ciLabel(f.action)}</Button
        >{/if}
    </DialogActions>
  </Dialog>{/if}
