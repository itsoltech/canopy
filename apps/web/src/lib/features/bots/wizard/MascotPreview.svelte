<script lang="ts">
  import { untrack } from "svelte";
  import { prefersReducedMotion } from "svelte/motion";
  import type { ClassValue } from "svelte/elements";
  import MascotFace from "../components/MascotFace.svelte";
  import { defaultAppearance, normalizeColor, type MascotShapeId } from "../mascot.ts";
  import { duration } from "#lib/shared/ui/motion.ts";

  let { shape, color, name, class: className }: { shape: MascotShapeId; color: string; name: string; class?: ClassValue } = $props();
  let displayedColor = $state(defaultAppearance.color);
  let current = $state<MascotShapeId>("round");
  let previous = $state<MascotShapeId>("round");
  let slot = $state<"a" | "b">("a");
  let character = $state<HTMLElement>();
  $effect(() => { const valid = normalizeColor(color); if (valid) displayedColor = valid; });
  $effect(() => {
    const next = shape;
    untrack(() => {
      if (next === (slot === "a" ? current : previous)) return;
      if (slot === "a") { previous = next; slot = "b"; }
      else { current = next; slot = "a"; }
    });
  });
  $effect(() => {
    name;
    const node = character;
    if (!node || prefersReducedMotion.current) return;
    const animation = node.animate([{ transform: "translateY(0)" }, { transform: "translateY(calc(-1 * var(--distance-micro)))", offset: 0.4 }, { transform: "translateY(0)" }], { duration: duration("fast"), easing: "ease-out" });
    return () => animation.cancel();
  });
</script>

<div class={["grid justify-items-center gap-1 rounded-2xl bg-zinc-950/3 px-4 py-3 dark:bg-white/4", className]}>
  <div bind:this={character} class="t-icon-swap size-40" data-state={slot} role="img" aria-label={`${name.trim() || 'Your bot'} preview`}>
    <div class="t-icon" data-icon="a"><MascotFace shape={current} color={displayedColor} blink={slot === 'a'} class="size-40" /></div>
    <div class="t-icon" data-icon="b"><MascotFace shape={previous} color={displayedColor} blink={slot === 'b'} class="size-40" /></div>
  </div>
  <p class="max-w-full truncate text-base/6 font-medium sm:text-sm/6">{name.trim() || 'Your new bot'}</p>
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
  .t-icon-swap[data-state="b"] .t-icon[data-icon="b"] { opacity: 1; filter: blur(0); transform: scale(1); }
  .t-icon-swap[data-state="a"] .t-icon[data-icon="b"],
  .t-icon-swap[data-state="b"] .t-icon[data-icon="a"] { opacity: 0; filter: blur(var(--icon-swap-blur)); transform: scale(var(--icon-swap-start-scale)); }
  @media (prefers-reduced-motion: reduce) { .t-icon-swap .t-icon { transition: none !important; } }
</style>
