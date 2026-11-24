<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SidebarFooterPopover from "#lib/features/navigation/SidebarFooterPopover.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ProgressRing from "#lib/shared/ui/ProgressRing.svelte";
  import { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import { updateCenter } from "#lib/features/workers/updates.svelte.ts";
  import { updateIndicator } from "#lib/features/workers/update-indicator.ts";
  import CompactUpdates from "#lib/features/workers/CompactUpdates.svelte";
  import { updatesHeadline } from "#lib/features/workers/updates-headline.ts";
  import type { FooterPopover } from "#lib/features/navigation/footer-popovers.svelte.ts";

  let { panel, class: className }: { panel: FooterPopover; class?: ClassValue } = $props();
  const updates = new DesktopUpdatesState();
  const center = updateCenter;
  const status = $derived(updates.status);

  const summary = $derived(
    updateIndicator(
      status,
      center.snapshot,
      updates.error || center.error,
      center.pending,
      updates.remote,
      center.gatewayTransition,
    ),
  );

  const phase = $derived(summary.phase);
  const busy = $derived(phase === "checking" || phase === "downloading" || center.run?.state === "running");
  const failed = $derived(phase === "error" || !!updates.error);
  const headline = $derived(updatesHeadline(center, updates, phase === "checking"));

  // Something waits for the user: an update to install or a download to restart into.
  const attention = $derived(!busy && !failed && (phase === "available" || phase === "ready"));
  const label = $derived(`Updates: ${headline.text}`);

  onMount(() => {
    const off = updates.connect();
    const stop = center.poll();

    return () => {
      off?.();
      stop();
    };
  });
</script>

<SidebarFooterPopover
  {panel}
  label="Updates"
  class={className}
  maxHeight="min(70dvh,32rem)"
  panelClass="w-[min(22rem,calc(100vw-1rem))]"
>
  {#snippet trigger(props)}
    <div class="relative">
      <!-- ⟳ stays Check now's: the trigger shows the download tray, a ring while updating, a dot for attention. -->
      <IconButton
        {...props}
        icon={failed ? "exclamation-circle" : "arrow-down-tray"}
        {label}
        aria-busy={busy || undefined}
        iconClass={[failed && "text-rose-600 dark:text-rose-400"]}
      />
      {#if busy && phase !== "checking"}<div class="pointer-events-none absolute inset-0 grid place-items-center">
          <ProgressRing label="Update progress" value={headline.progress ?? summary.progress} class="t-rise size-7" />
        </div>{/if}
      {#if attention}<span
          class="t-rise pointer-events-none absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand-600 dark:bg-brand-400"
          aria-hidden="true"
        ></span>{/if}
    </div>
  {/snippet}
  <CompactUpdates updates={center} app={updates} onnotes={panel.close} />
</SidebarFooterPopover>
