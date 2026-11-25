<script lang="ts">
  import type { AgentPreviewCursor, AgentPreviewEvent } from "@canopy/contracts";
  import { agentCursor } from "@canopy/ui/agent-cursor";
  import { tick } from "svelte";
  import type { HTMLCanvasAttributes } from "svelte/elements";
  import { paintPreviewFrame } from "./preview-frame.ts";

  const { shadow } = agentCursor;
  const dropShadow = `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur}px rgb(0 0 0 / ${shadow.opacity}))`;

  let {
    frame,
    canvas = $bindable(),
    onpaint,
    onframeerror,
    ...attributes
  }: HTMLCanvasAttributes & {
    frame?: AgentPreviewEvent;
    canvas?: HTMLCanvasElement;
    onpaint: (frame: AgentPreviewEvent) => void;
    onframeerror: (frame: AgentPreviewEvent) => void;
  } = $props();

  const scope = $derived(frame && `${frame.previewId}:${frame.targetId}`);
  let paintedScope = $state<string>();
  let cursor = $state.raw<AgentPreviewCursor>();
  let lastAction = "";
  let marker = $state<HTMLDivElement>();
  let pulse = $state("");

  async function clickOnArrival(actionId: string): Promise<void> {
    await tick();
    const element = marker;

    if (!element || cursor?.actionId !== actionId) return;
    // A click can follow a move to the same point while the pointer is still in transit.
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));

    if (marker === element && cursor?.actionId === actionId) pulse = actionId;
  }

  $effect(() => {
    const target = canvas;
    const next = frame;
    const key = scope;

    if (!target || !next?.data.length || !key) {
      paintedScope = undefined;
      cursor = undefined;
      lastAction = "";

      return;
    }

    return paintPreviewFrame(
      target,
      next,
      (painted) => {
        const point = painted.agentObservation ? undefined : painted.cursor;
        const first = paintedScope !== key;

        if (first || point?.actionId !== cursor?.actionId) {
          // The first image can already contain a click from before this watch opened.
          pulse = "";

          if (!first && point?.click && point.actionId !== lastAction) void clickOnArrival(point.actionId);
        }

        if (first || point) lastAction = point?.actionId ?? "";
        paintedScope = key;
        cursor = point;
        onpaint(painted);
      },
      onframeerror,
    );
  });
</script>

<canvas bind:this={canvas} {...attributes}></canvas>
{#if cursor && scope === paintedScope}
  <div aria-hidden="true" class="pointer-events-none absolute inset-0 overflow-hidden" style:color={agentCursor.fill}>
    <div
      bind:this={marker}
      class="cursor-position absolute inset-0"
      style:transform={`translate(${cursor.x * 100}%, ${cursor.y * 100}%)`}
    >
      {#if pulse === cursor.actionId}
        <span class="click-ring"></span>
      {/if}
      <svg
        class="absolute -top-[16px] -left-[16px]"
        style:filter={dropShadow}
        width="68"
        height="72"
        viewBox="-16 -16 68 72"
        stroke-linejoin="round"
      >
        <path
          d={agentCursor.path}
          fill={agentCursor.rim}
          stroke={agentCursor.rim}
          stroke-width={agentCursor.rimStroke}
        />
        <path d={agentCursor.path} fill="currentColor" stroke="currentColor" stroke-width={agentCursor.fillStroke} />
      </svg>
    </div>
  </div>
{/if}

<style>
  .cursor-position {
    transition: transform var(--duration-fast) var(--ease-smooth-out);
  }

  .click-ring {
    position: absolute;
    width: 28px;
    height: 28px;
    top: -14px;
    left: -14px;
    border: 2px solid currentColor;
    border-radius: 50%;
    box-shadow: 0 0 0 1px white;
    opacity: 0;
    animation: click-ring var(--duration-medium) ease-out;
  }

  @keyframes click-ring {
    from {
      opacity: 1;
      scale: var(--ring-start, 0.35);
    }
    to {
      opacity: 0;
      scale: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cursor-position {
      transition: none;
    }
    .click-ring {
      --ring-start: 1;
    }
  }
</style>
