<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import { mountVisualFrame, VisualUnavailable, type FrameHandle } from "./frame-host.ts";

  /**
   * One live sandboxed frame for a loaded visual version. `active` follows visibility: false pauses animations
   * at once. The frame, its port and listeners go away when this component unmounts.
   */
  let {
    response,
    maxHeight,
    active,
    onheight,
    onframe,
    onescape,
  }: {
    response: ui.GetVisualResponse;
    maxHeight: number;
    active: boolean;
    onheight?: ((height: number) => void) | undefined;
    onframe?: ((frame: HTMLIFrameElement | undefined) => void) | undefined;
    onescape?: (() => void) | undefined;
  } = $props();

  let host = $state<HTMLElement>();
  let handle = $state<FrameHandle>();
  let failure = $state("");
  let attempt = $state(0);

  $effect(() => {
    const element = host;
    const visual = response.visual;
    void attempt;

    if (!element || !visual) return;
    let cancelled = false;
    let mounted: FrameHandle | undefined;
    failure = "";

    mountVisualFrame(element, {
      title: visual.title,
      visualId: visual.visualId,
      version: visual.version,
      kitVersion: visual.kitVersion,
      specJson: response.specJson,
      maxHeight,
      onHeight: (height) => onheight?.(height),
      onError: (message) => (failure = message),
      onEscape: () => onescape?.(),
    }).then(
      (frame) => {
        if (cancelled) return frame.destroy();
        mounted = frame;
        handle = frame;
        onframe?.(frame.frame);
      },
      (cause: unknown) => {
        if (!cancelled) failure = cause instanceof VisualUnavailable ? cause.message : "Couldn't open this visual.";
      },
    );

    return () => {
      cancelled = true;
      mounted?.destroy();
      handle = undefined;
      onframe?.(undefined);
    };
  });

  $effect(() => handle?.visible(active));
</script>

<div bind:this={host} class={["min-w-0", failure && "hidden"]}></div>
{#if failure}
  <div role="alert" class="flex min-h-40 flex-col items-center justify-center gap-2 p-4 text-center">
    <p class="text-base/7 text-zinc-700 sm:text-sm/6 dark:text-zinc-300">{failure}</p>
    {#if !failure.startsWith("Update")}<Button variant="secondary" size="sm" onclick={() => attempt++}>Retry</Button
      >{/if}
  </div>
{/if}
