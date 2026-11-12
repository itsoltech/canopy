<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ProgressRing from "#lib/shared/ui/ProgressRing.svelte";
  import { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import { updateCenter } from "#lib/features/workers/updates.svelte.ts";
  import { updateIndicator } from "#lib/features/workers/update-indicator.ts";
  import CompactUpdates from "#lib/features/workers/CompactUpdates.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const updates = new DesktopUpdatesState();
  const center = updateCenter;
  let open = $state(false);
  let pinned = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const status = $derived(updates.status);

  const summary = $derived(
    updateIndicator(status, center.snapshot, updates.error || center.error, center.pending, updates.remote),
  );

  const phase = $derived(summary.phase);
  const busy = $derived(phase === "checking" || phase === "downloading");

  const label = $derived(`Updates: ${summary.message}`);

  onMount(() => {
    const off = updates.connect();
    const stop = center.poll();

    return () => {
      off?.();
      stop();
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
        {#if phase === "downloading"}<div class="pointer-events-none absolute inset-0 grid place-items-center">
            <ProgressRing label="Update progress" value={summary.progress} class="size-7" />
          </div>{/if}
      </div>
    {/snippet}
    <CompactUpdates
      updates={center}
      app={updates}
      onnotes={() => {
        open = false;
        pinned = false;
      }}
    />
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
