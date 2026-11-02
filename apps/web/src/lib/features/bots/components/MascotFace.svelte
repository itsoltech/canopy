<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { defaultAppearance, eyeColor, mascotShapes, type MascotShapeId } from "../mascot.ts";

  /** A shared 40×40 drawing, from tiny avatars to the wizard's large preview. */
  let { shape = "round", color = defaultAppearance.color, blink = false, label, class: className }: {
    shape?: MascotShapeId;
    color?: string;
    blink?: boolean;
    label?: string;
    class?: ClassValue;
  } = $props();
  const body = $derived(mascotShapes.find((s) => s.id === shape) ?? mascotShapes[0]);
</script>

<svg viewBox="0 0 40 40" class={["shrink-0", className]} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"} style:--mascot-color={color} style:--eye-color={eyeColor(color)}>
  <path d={body.body} class="mascot-body fill-(--mascot-color)" />
  <g class:blinking={blink} class="eyes fill-(--eye-color)" style:--eye-y={`${body.eyeY}px`}>
    <ellipse cx="16" cy={body.eyeY} rx="2.1" ry="3.2" />
    <ellipse cx="24" cy={body.eyeY} rx="2.1" ry="3.2" />
  </g>
</svg>

<style>
  .mascot-body, .eyes { transition: fill var(--duration-fast) var(--ease-in-out); }
  .eyes { transform-origin: 20px var(--eye-y); }
  .blinking { animation: mascot-blink calc(var(--duration-very-slow) * 11) var(--ease-in-out) infinite; }
  @keyframes mascot-blink { 0%, 91%, 97%, 100% { transform: scaleY(1); } 94% { transform: scaleY(0.08); } }
  @media (prefers-reduced-motion: reduce) {
    .mascot-body, .eyes { transition: none; }
    .blinking { animation: none; }
  }
</style>
