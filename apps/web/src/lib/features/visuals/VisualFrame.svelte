<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { clampVisualHeight, VISUAL_LIMITS } from "@canopy/domain/visuals";
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
    onframe?: ((frame: HTMLElement | undefined) => void) | undefined;
    onescape?: (() => void) | undefined;
  } = $props();

  let host = $state<HTMLElement>();
  let handle = $state<FrameHandle>();
  let failure = $state("");
  let attempt = $state(0);
  let run = $state(false);
  let stageHeight = $state(0);
  let footer = $state<HTMLElement>();
  let footerHeight = $state(0);

  const reserved = $derived(
    stageHeight || clampVisualHeight(response.visual?.height || VISUAL_LIMITS.defaultHeight, maxHeight),
  );

  const desktopHtml = $derived(
    response.visual?.htmlDocument && typeof window !== "undefined" && !!window.canopyDesktop,
  );

  async function openWindow() {
    if (!window.canopyDesktop?.openAgentHtml) return;

    try {
      await window.canopyDesktop.openAgentHtml(response.specJson, response.visual?.title ?? "Visual");
    } catch {
      failure = "Couldn't open this visual.";
    }
  }

  $effect(() => {
    const element = host;
    const visual = response.visual;
    void attempt;

    if (!element || !visual || failure || (visual.htmlDocument && !run)) return;
    let cancelled = false;
    const abort = new AbortController();
    let mounted: FrameHandle | undefined;

    mountVisualFrame(element, {
      title: visual.title,
      visualId: visual.visualId,
      version: visual.version,
      kitVersion: visual.kitVersion,
      htmlDocument: visual.htmlDocument,
      specJson: response.specJson,
      maxHeight,
      initialHeight: untrack(() => reserved),
      signal: abort.signal,
      onHeight: (height) => (stageHeight = height),
      onError: (message) => {
        failure = message;
        mounted?.destroy();
      },
      onEscape: () => onescape?.(),
      onReplaced: () => (run = false),
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
      abort.abort();
      mounted?.destroy();
      handle = undefined;
      onframe?.(undefined);
    };
  });

  $effect(() => handle?.visible(active));

  $effect(() => onheight?.(reserved + footerHeight));

  $effect(() => {
    if (!footer) return;
    const observer = new ResizeObserver(([entry]) => (footerHeight = entry?.borderBoxSize[0]?.blockSize ?? 0));

    observer.observe(footer);

    return () => observer.disconnect();
  });
</script>

<div bind:this={host} class={["min-w-0", failure && "hidden"]}></div>
{#if response.visual?.htmlDocument && !run && !failure}
  <div class="flex items-center justify-center p-4" style:min-height="{reserved}px">
    <Button variant="secondary" size="sm" onclick={() => (run = true)}>Run</Button>
  </div>
{/if}
{#if failure}
  <div
    role="alert"
    class="flex flex-col items-center justify-center gap-2 p-4 text-center"
    style:min-height="{reserved}px"
  >
    <p class="text-base/7 text-zinc-700 sm:text-sm/6 dark:text-zinc-300">{failure}</p>
    {#if !failure.startsWith("Update")}<Button
        variant="secondary"
        size="sm"
        onclick={() => {
          failure = "";
          attempt++;
        }}>Retry</Button
      >{/if}
  </div>
{/if}
{#if desktopHtml && window.canopyDesktop?.openAgentHtml}
  <div bind:this={footer} class="flex justify-end border-t border-zinc-950/5 p-1 dark:border-white/5">
    <Button variant="ghost" size="sm" onclick={openWindow}>Open in window</Button>
  </div>
{/if}
