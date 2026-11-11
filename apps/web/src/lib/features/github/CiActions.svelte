<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { ciLabel, ciEffect, ciReason, type CiAction } from "@canopy/domain/github-ci";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
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
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    runId: string;
    state: string;
    jobId?: string;
    name?: string;
    dialog?: boolean;
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

  const actions = $derived(jobId ? (["job", "cancel"] as const) : (["all", "failed", "cancel"] as const));

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

{#if !dialog}<div class={["shrink-0", className]}>
    <div class="flex shrink-0 items-center gap-1" aria-label="CI actions">
      {#each actions as action, i}
        {@const inspect = !!f.receipt && i === 0}
        <span
          {@attach tooltip(
            inspect
              ? "Check CI request"
              : reason(action) || (blocked ? "Check current state before another CI action." : ciLabel(action)),
          )}
        >
          <IconButton
            icon={inspect
              ? "clock"
              : action === "cancel"
                ? "stop"
                : action === "failed"
                  ? "arrow-path-rounded-square"
                  : "arrow-path"}
            label={inspect ? "Check CI request" : ciLabel(action)}
            tooltipText=""
            aria-description={inspect ? undefined : reason(action) || undefined}
            size="sm"
            disabled={f.busy || (!inspect && (blocked || !!reason(action)))}
            onclick={() => void choose(action)}
          />
        </span>
      {/each}
    </div>
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
