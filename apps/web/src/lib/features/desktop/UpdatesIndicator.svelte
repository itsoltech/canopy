<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateProgress from "#lib/features/workers/UpdateProgress.svelte";
  import { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import { UpdatesState } from "#lib/features/workers/updates.svelte.ts";
  import { updateIndicator } from "#lib/features/workers/update-indicator.ts";
  import CompactUpdates from "#lib/features/workers/CompactUpdates.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const updates = new DesktopUpdatesState();
  const center = new UpdatesState();
  let open = $state(false);
  let pinned = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const status = $derived(updates.status);
  const summary = $derived(updateIndicator(status, center.snapshot, updates.error || center.error, center.pending));
  const phase = $derived(summary.phase);
  const busy = $derived(phase === "checking" || phase === "downloading");

  const label = $derived(`Updates: ${summary.message}`);

  onMount(() => {
    const off = updates.connect();
    void center.reload();
    const timer = setInterval(() => void center.reload(), 5000);

    return () => {
      off?.();
      clearInterval(timer);
      clearTimeout(closeTimer);
    };
  });

  function hover(event: PointerEvent) {
    clearTimeout(closeTimer);

    if (event.pointerType === "mouse" && window.matchMedia("(min-width: 40rem)").matches) open = true;
  }

  function leave() {
    if (!pinned)
      closeTimer = setTimeout(() => {
        open = false;
      }, 250);
  }
</script>

<div role="group" aria-label="Update controls" onpointerenter={hover} onpointerleave={leave} class={className}>
  <Popover
    bind:open
    label="Updates"
    placement="top-start"
    sheet
    focusOnOpen={pinned}
    maxHeight="min(70dvh,32rem)"
    class="w-[min(22rem,calc(100vw-1rem))]"
    onclose={() => {
      pinned = false;
    }}
  >
    {#snippet trigger(props)}
      <div class="relative">
        <IconButton
          {...props}
          icon={phase === "ready"
            ? "check-circle"
            : phase === "error" || updates.error
              ? "exclamation-circle"
              : phase === "available"
                ? "arrow-up"
                : "arrow-path"}
          {label}
          aria-busy={busy || undefined}
          onclick={() => {
            open = !pinned;
            pinned = open;
          }}
          iconClass={[
            busy && "updates-refresh",
            phase === "ready" && "text-emerald-600 dark:text-emerald-400",
            phase === "available" && "text-brand-600 dark:text-brand-400",
            (phase === "error" || updates.error) && "text-rose-600 dark:text-rose-400",
          ]}
        />
        {#if phase === "downloading"}<div class="pointer-events-none absolute inset-x-2 bottom-1">
            <UpdateProgress label="Update progress" value={summary.progress} />
          </div>{/if}
      </div>
    {/snippet}
    <CompactUpdates updates={center} app={updates} />
  </Popover>
</div>

<style>
  :global(.updates-refresh) {
    animation: updates-refresh calc(var(--duration-very-slow) * 2) var(--ease-linear) infinite;
  }
  @keyframes updates-refresh {
    to {
      rotate: 360deg;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.updates-refresh) {
      animation: none;
    }
  }
</style>
