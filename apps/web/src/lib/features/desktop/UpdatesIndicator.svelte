<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import AppUpdateCard from "./AppUpdateCard.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const updates = new DesktopUpdatesState();
  let open = $state(false);
  let pinned = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const status = $derived(updates.status);
  const phase = $derived(status?.phase);
  const busy = $derived(phase === "checking" || phase === "downloading");

  const label = $derived(
    `Updates: ${updates.error || status?.message || "Loading app update status"}${phase === "downloading" ? ` ${Math.round(status?.progress ?? 0)}%` : ""}`,
  );

  onMount(() => {
    const off = updates.connect();

    return () => {
      off?.();
      clearTimeout(closeTimer);
    };
  });

  function hover(event: PointerEvent) {
    clearTimeout(closeTimer);

    if (event.pointerType === "mouse") open = true;
  }

  function leave() {
    if (!pinned)
      closeTimer = setTimeout(() => {
        open = false;
      }, 250);
  }
</script>

{#if status || updates.error}
  <div role="group" aria-label="Update controls" onpointerenter={hover} onpointerleave={leave} class={className}>
    <Popover
      bind:open
      label="Updates"
      placement="top-start"
      sheet
      focusOnOpen={pinned}
      maxHeight="min(75dvh,40rem)"
      class="w-[min(32rem,calc(100vw-1rem))]"
      onclose={() => {
        pinned = false;
      }}
    >
      {#snippet trigger(props)}
        <div class="relative">
          <IconButton
            {...props}
            icon={phase === "downloaded"
              ? "check-circle"
              : phase === "error" || updates.error
                ? "exclamation-circle"
                : "arrow-path"}
            {label}
            onclick={() => {
              open = !pinned;
              pinned = open;
            }}
            iconClass={[
              busy && "updates-refresh",
              phase === "downloaded" && "text-emerald-600 dark:text-emerald-400",
              (phase === "error" || updates.error) && "text-rose-600 dark:text-rose-400",
            ]}
          />
          {#if phase === "downloading"}<div class="pointer-events-none absolute inset-x-1 bottom-0">
              <ProgressBar label="App update download" value={status?.progress ?? 0} />
            </div>{/if}
        </div>
      {/snippet}
      <div class="grid gap-5 p-5">
        <h2 class="text-lg font-semibold">Updates</h2>
        <AppUpdateCard {updates} />
      </div>
    </Popover>
  </div>
{/if}

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
