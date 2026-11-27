<script lang="ts">
  import type { ActivityNotchEdge } from "@canopy/ui/desktop";

  /** A small screen with three spots per edge. Dragging the overlay reaches any spot in between. */
  let {
    edge,
    offset,
    onpick,
  }: {
    edge: ActivityNotchEdge;
    offset: number;
    onpick: (edge: ActivityNotchEdge, offset: number) => void;
  } = $props();

  const offsets = [0.25, 0.5, 0.75] as const;
  const across = { top: ["left", "center", "right"], bottom: ["left", "center", "right"] } as const;
  const along = ["top", "middle", "bottom"] as const;
  const edgeNames = { top: "Top", right: "Right", bottom: "Bottom", left: "Left" } as const;
  const order: readonly ActivityNotchEdge[] = ["top", "right", "bottom", "left"];

  const spots = order.flatMap((side) =>
    offsets.map((value, index) => ({
      edge: side,
      offset: value,
      label: `${edgeNames[side]} edge, ${side === "top" || side === "bottom" ? across[side][index] : along[index]}`,
    })),
  );

  const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });
  const horizontal = $derived(edge === "top" || edge === "bottom");

  const place = $derived(`${edgeNames[edge]} edge, ${percent.format(offset)} from the ${horizontal ? "left" : "top"}`);

  const chosen = (spot: (typeof spots)[number]) => spot.edge === edge && Math.abs(spot.offset - offset) < 0.005;
  const focusable = $derived(spots.findIndex(chosen) === -1 ? spots.findIndex((spot) => spot.edge === edge) : -1);

  function position(spot: (typeof spots)[number]) {
    const share = `${spot.offset * 100}%`;

    if (spot.edge === "top") return `left: ${share}; top: 0`;

    if (spot.edge === "bottom") return `left: ${share}; top: 100%`;

    return `left: ${spot.edge === "left" ? "0" : "100%"}; top: ${share}`;
  }

  /** The tab itself, drawn where it docks: on a spot or anywhere a drag left it. */
  const marker = $derived.by(() => {
    const share = `${offset * 100}%`;

    if (edge === "top") return `left: ${share}; top: 0; width: 1.25rem; height: 0.375rem; margin-left: -0.625rem`;

    if (edge === "bottom")
      return `left: ${share}; top: 100%; width: 1.25rem; height: 0.375rem; margin: -0.375rem 0 0 -0.625rem`;

    return `left: ${edge === "left" ? "0" : "100%"}; top: ${share}; width: 0.375rem; height: 1.25rem; margin: -0.625rem 0 0 ${edge === "left" ? "0" : "-0.375rem"}`;
  });

  const steps = new Map([
    ["ArrowRight", 1],
    ["ArrowDown", 1],
    ["ArrowLeft", -1],
    ["ArrowUp", -1],
  ]);

  function navigate(event: KeyboardEvent, index: number) {
    const step = steps.get(event.key);

    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? spots.length - 1
          : step === undefined
            ? undefined
            : (index + step + spots.length) % spots.length;

    const spot = target === undefined ? undefined : spots[target];

    if (target === undefined || !spot || !(event.currentTarget instanceof HTMLElement)) return;

    event.preventDefault();
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus();
    onpick(spot.edge, spot.offset);
  }
</script>

<div class="grid justify-items-end gap-1.5">
  <div
    role="radiogroup"
    aria-label="Edge spot"
    class="relative m-3 h-24 w-40 rounded-lg bg-zinc-200 ring-1 ring-divider dark:bg-zinc-800"
  >
    <span
      class="pointer-events-none absolute rounded-xs bg-zinc-950 transition-[left,top] duration-(--duration-fast) ease-(--ease-smooth-out) motion-reduce:transition-none dark:bg-zinc-100"
      style={marker}
      aria-hidden="true"
    ></span>
    {#each spots as spot, index (spot.label)}
      <button
        type="button"
        role="radio"
        aria-label={spot.label}
        aria-checked={chosen(spot)}
        tabindex={chosen(spot) || index === focusable ? 0 : -1}
        style={position(spot)}
        class="absolute grid size-6 -translate-1/2 cursor-pointer place-items-center rounded-full focus-ring"
        onclick={() => onpick(spot.edge, spot.offset)}
        onkeydown={(event) => navigate(event, index)}
      >
        <span
          class={[
            "size-3 rounded-full ring-1 transition-[scale,background-color] duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:transition-none",
            chosen(spot) ? "scale-125 bg-action ring-action" : "bg-surface ring-zinc-400 dark:ring-zinc-500",
          ]}
        ></span>
      </button>
    {/each}
  </div>
  <p class="text-sm/5 text-muted tabular-nums" aria-live="polite">{place}</p>
</div>
