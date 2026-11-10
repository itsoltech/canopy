<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import type { OverviewConnection } from "#lib/features/overview/overview-state.svelte.ts";
  import type { RecoverySnapshot } from "@canopy/domain/connection-recovery";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  /**
   * Gateway connection of this tab, announced politely when it changes. `quietWhenLive`: the gateway is part of this
   * app (desktop local mode), so only trouble is worth showing.
   */
  let {
    connection,
    quietWhenLive = false,
    recovery,
    class: className,
  }: {
    connection: OverviewConnection;
    quietWhenLive?: boolean;
    recovery?: RecoverySnapshot;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    if (!open || !recovery?.retryAt) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);

    return () => clearInterval(timer);
  });

  const seconds = $derived(Math.max(0, Math.ceil(((recovery?.retryAt ?? now) - now) / 1000)));

  const look = $derived(
    (
      {
        live: { tone: "emerald", label: "Connected" },
        reconnecting: { tone: "amber", label: "Reconnecting…" },
        unavailable: { tone: "rose", label: "Gateway unavailable" },
      } satisfies Record<OverviewConnection, { tone: Tone; label: string }>
    )[connection],
  );
</script>

<!-- The width of the longest label stays reserved (no shift when it changes), on the left: the dot keeps to its word. -->
<!-- The live region stays mounted while quiet, so a later reconnect is still announced. -->
<Popover bind:open label="Connection" placement="top-end" sheet class="w-80 max-w-[calc(100vw-1rem)]">
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      aria-label={`${look.label}. Show connection details`}
      class={[
        "flex items-center rounded-md text-sm/5 text-zinc-500 hover:bg-hover sm:text-xs/5 dark:text-zinc-400",
        className,
      ]}
    >
      {#if !(quietWhenLive && connection === "live")}
        <span class="flex w-32 max-w-full min-w-0 items-center justify-end gap-2 sm:w-28">
          <StatusDot tone={look.tone} active={connection === "reconnecting"} />
          <span class="truncate">{look.label}</span>
        </span>
      {/if}
    </button>
  {/snippet}
  <div class="grid gap-3 p-4">
    <div class="flex items-center gap-2" role="status">
      <StatusDot tone={look.tone} />
      <h2 class="font-medium">{look.label}</h2>
    </div>
    <p class="h-15 text-muted">
      {connection === "live"
        ? "Live updates are on."
        : "Canopy shows the last known state and reconnects automatically."}
    </p>
    <div class="flex h-5 items-center gap-2 text-muted">
      <span class="size-4"
        >{#if connection !== "live" && recovery?.retrying}<Spinner />{/if}</span
      >
      <span class="tabular-nums"
        >{connection === "live"
          ? ""
          : seconds && !recovery?.retrying
            ? `Retrying in ${seconds.toLocaleString()} s`
            : "Retrying…"}</span
      >
    </div>
    <div class="flex h-8 justify-end">
      <Button
        size="sm"
        disabled={connection === "live"}
        onclick={() => window.dispatchEvent(new Event("canopy:reconnect"))}>Reconnect now</Button
      >
    </div>
  </div>
</Popover>
