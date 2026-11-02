<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { defaultAppearance, eyeColor, mascotShapes, normalizeColor, type Mascot, type MascotShapeId } from "../mascot.ts";
  import { mascotBehaviour, type MascotState } from "../behaviour.ts";

  /** A shared 40×40 drawing, from tiny avatars to the wizard's large preview. */
  let { shape = "round", color, blink = false, label, alive = true, state = "idle", event, reaction, playful = false, legacy, class: className }: {
    shape?: MascotShapeId;
    color?: string;
    blink?: boolean;
    alive?: boolean;
    state?: MascotState;
    event?: unknown;
    reaction?: string;
    playful?: boolean;
    /** Internal legacy drawing; preserves hashed shapes, colours, pupils and smiles. */
    legacy?: Mascot;
    label?: string;
    class?: ClassValue;
  } = $props();
  const body = $derived(legacy?.shape ?? mascotShapes.find((s) => s.id === shape) ?? mascotShapes[0]);
  const customColor = $derived(normalizeColor(color ?? ""));
  const fill = $derived(customColor ?? defaultAppearance.color);
  const eyeX = [16, 24];
</script>

<svg use:mascotBehaviour={{ shape: body, alive, state, event, reaction, playful, pupils: legacy?.eyes === "round" }} data-mascot data-state={state} viewBox="0 0 40 40" class={["shrink-0", className]} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"} style:--mascot-color={fill} style:--eye-color={eyeColor(fill)}>
  <g data-mascot-character>
    <path d={body.body} class={["mascot-body", legacy && !customColor ? legacy.tone.body : "fill-(--mascot-color)"]} />
    <g data-mascot-lids class:blinking={blink} class="eyes fill-(--eye-color)">
      {#if legacy?.eyes === "round"}
        {#each eyeX as x (x)}<circle cx={x} cy={body.eyeY} r="3.2" class="fill-white" />{/each}
      {/if}
      <g data-mascot-gaze>
        {#each eyeX as x (x)}
          {#if !legacy}
            <ellipse cx={x} cy={body.eyeY} rx="2.1" ry="3.2" />
          {:else if legacy.eyes === "round"}
            <circle cx={x + legacy.gaze * 0.9} cy={body.eyeY + 0.4} r="1.6" class="fill-zinc-950" />
          {:else if legacy.eyes === "dots"}
            <circle cx={x} cy={body.eyeY} r="1.9" class="fill-(--eye-color)" />
          {:else}
            <path d="M{x - 2.4} {body.eyeY + 0.8}q2.4 -3 4.8 0" class="fill-none stroke-(--eye-color)" stroke-width="1.6" stroke-linecap="round" />
          {/if}
        {/each}
      </g>
    </g>
    {#if legacy?.smile}
      <path d="M17.5 {body.eyeY + 4.5}q2.5 2.2 5 0" class="fill-none stroke-(--eye-color)" stroke-width="1.4" stroke-linecap="round" />
    {/if}
  </g>
</svg>

<style>
  .mascot-body, .eyes { transition: fill var(--duration-fast) var(--ease-in-out); }
  @media (prefers-reduced-motion: reduce) {
    .mascot-body, .eyes { transition: none; }
  }
</style>
