<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import MascotFace from "../components/MascotFace.svelte";
  import { defaultAppearance, normalizeColor, type MascotShapeId } from "../mascot.ts";

  let {
    shape,
    color,
    name,
    class: className,
  }: { shape: MascotShapeId; color: string; name: string; class?: ClassValue } = $props();

  let displayedColor = $state(defaultAppearance.color);
  let current = $state<MascotShapeId>("round");
  let previous = $state<MascotShapeId>("round");
  let slot = $state<"a" | "b">("a");
  let play = $state(0);

  $effect(() => {
    const valid = normalizeColor(color);

    if (valid) displayedColor = valid;
  });

  $effect(() => {
    const next = shape;
    untrack(() => {
      if (next === (slot === "a" ? current : previous)) return;

      if (slot === "a") {
        previous = next;
        slot = "b";
      } else {
        current = next;
        slot = "a";
      }
    });
  });
</script>

<div class={["grid justify-items-center gap-1 rounded-2xl bg-zinc-950/3 px-4 py-3 dark:bg-white/4", className]}>
  <button
    type="button"
    class="t-icon-swap size-40 cursor-pointer rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand-500"
    data-state={slot}
    aria-label={`Play with ${name.trim() || "your bot"}`}
    onclick={() => play++}
  >
    <span class="t-icon" data-icon="a"
      ><MascotFace
        shape={current}
        color={displayedColor}
        alive={slot === "a"}
        reaction={name}
        event={play}
        playful
        class="size-40"
      /></span
    >
    <span class="t-icon" data-icon="b"
      ><MascotFace
        shape={previous}
        color={displayedColor}
        alive={slot === "b"}
        reaction={name}
        event={play}
        playful
        class="size-40"
      /></span
    >
  </button>
  <p class="max-w-full truncate text-base/6 font-medium sm:text-sm/6">{name.trim() || "Your new bot"}</p>
</div>

<style>
  .t-icon-swap {
    --icon-swap-dur: var(--duration-fast);
    --icon-swap-blur: var(--blur-small);
    --icon-swap-start-scale: var(--scale-large);
    --icon-swap-ease: var(--ease-in-out);
    position: relative;
    display: inline-grid;
  }
  .t-icon-swap .t-icon {
    grid-area: 1 / 1;
    transition:
      opacity var(--icon-swap-dur) var(--icon-swap-ease),
      filter var(--icon-swap-dur) var(--icon-swap-ease),
      transform var(--icon-swap-dur) var(--icon-swap-ease);
  }
  .t-icon-swap[data-state="a"] .t-icon[data-icon="a"],
  .t-icon-swap[data-state="b"] .t-icon[data-icon="b"] {
    opacity: 1;
    filter: blur(0);
    transform: scale(1);
  }
  .t-icon-swap[data-state="a"] .t-icon[data-icon="b"],
  .t-icon-swap[data-state="b"] .t-icon[data-icon="a"] {
    opacity: 0;
    pointer-events: none;
    filter: blur(var(--icon-swap-blur));
    transform: scale(var(--icon-swap-start-scale));
  }
  @media (prefers-reduced-motion: reduce) {
    .t-icon-swap .t-icon {
      transition: none !important;
    }
  }
</style>
