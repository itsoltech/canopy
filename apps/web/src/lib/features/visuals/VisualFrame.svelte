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
  let run = $state(false);

  const desktopHtml = $derived(
    response.visual?.htmlDocument && typeof window !== "undefined" && Boolean(window.canopyDesktop),
  );

  async function openDesktopHtml() {
    if (!window.canopyDesktop?.openAgentHtml) {
      failure = "Update Canopy to open this visual.";

      return;
    }

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

    if (!element || !visual || desktopHtml || failure || (visual.htmlDocument && !run)) return;
    let cancelled = false;
    let mounted: FrameHandle | undefined;

    mountVisualFrame(element, {
      title: visual.title,
      visualId: visual.visualId,
      version: visual.version,
      kitVersion: visual.kitVersion,
      htmlDocument: visual.htmlDocument,
      specJson: response.specJson,
      maxHeight,
      onHeight: (height) => onheight?.(height),
      onError: (message) => {
        failure = message;
        mounted?.destroy();
      },
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

{#if response.visual?.htmlDocument}
  <p
    class="border-b border-zinc-950/10 px-3 py-2 text-base/7 text-zinc-600 sm:text-sm/6 dark:border-white/10 dark:text-zinc-400"
  >
    Custom HTML from the agent. Don't enter passwords or secrets.
  </p>
{/if}
<div bind:this={host} class={["min-w-0", failure && "hidden"]}></div>
{#if desktopHtml && !failure}
  <div class="flex min-h-40 items-center justify-center p-4">
    <Button variant="secondary" size="sm" onclick={openDesktopHtml}>Open visual in a separate window</Button>
  </div>
{/if}
{#if response.visual?.htmlDocument && !desktopHtml && !run}
  <div class="flex min-h-40 items-center justify-center p-4">
    <Button variant="secondary" size="sm" onclick={() => (run = true)}>Run</Button>
  </div>
{/if}
{#if failure}
  <div role="alert" class="flex min-h-40 flex-col items-center justify-center gap-2 p-4 text-center">
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
