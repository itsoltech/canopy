<script lang="ts">
  import type { MessageInitShape } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { appUpdateAvailable, bulkUpdatesAvailable } from "@canopy/domain/release/update-plan";
  import { homeAppComputer } from "@canopy/domain/release/update-actions";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { ButtonVariant } from "#lib/shared/ui/button.ts";
  import AppUpdateConfirmation from "./AppUpdateConfirmation.svelte";
  import type { UpdatesState } from "./updates.svelte.ts";

  /**
   * The labelled bulk action: Update all, Retry failed or one step's Retry. While a run starts or runs it stays in
   * place as a disabled "Starting…" / "Updating…" with a spinner, so a click shows at once and nothing moves.
   */
  let {
    updates,
    request = { action: "update_all" },
    variant = "secondary",
    class: className,
  }: {
    updates: UpdatesState;
    request?: MessageInitShape<typeof ui.ManageUpdatesRequestSchema>;
    variant?: ButtonVariant;
    class?: ClassValue;
  } = $props();

  let confirming = $state(false);
  const snapshot = $derived(updates.snapshot);
  const running = $derived(updates.run?.state === "running");
  const starting = $derived(!!updates.optimistic && !!updates.pending && updates.pending !== "check");
  const retry = $derived(request.action === "retry_step" || request.action === "retry_failed");
  const local = $derived(snapshot && homeAppComputer(snapshot));

  const restarts = $derived(
    request.action === "retry_step"
      ? snapshot?.run?.steps[request.updateStepIndex ?? 0]?.kind === "app"
      : request.action === "retry_failed"
        ? !!snapshot?.run?.steps.some((step) => step.kind === "app" && ["failed", "blocked"].includes(step.state))
        : snapshot?.appUpdateSupported && appUpdateAvailable(snapshot.app),
  );

  const label = $derived(
    starting
      ? "Starting…"
      : running
        ? "Updating…"
        : request.action === "retry_failed"
          ? "Retry failed"
          : retry
            ? "Retry"
            : "Update all",
  );

  function act() {
    if (restarts && local) confirming = true;
    else void updates.manage(request);
  }
</script>

{#if retry || running || starting || (snapshot && bulkUpdatesAvailable(snapshot))}
  <Button size="sm" {variant} loading={running || starting} disabled={!!updates.pending} onclick={act} class={className}
    >{label}</Button
  >
{/if}
{#if local}<AppUpdateConfirmation bind:open={confirming} computer={local} {updates} {request} />{/if}
