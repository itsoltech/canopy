<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  /** Shared disclosure rhythm for the stacked panels; the hit area is independent of visual height. */
  let { expanded, controls, onclick, children, class: className }: {
    expanded: boolean; controls: string; onclick: (wasExpanded: boolean) => void; children: Snippet; class?: ClassValue;
  } = $props();
  // Focusing a summary expands the composer before click. Toggle from the pressed state,
  // so restoring an open queue/question does not immediately close it again.
  let pressedExpanded: boolean | undefined;
</script>

<button type="button" class={["t-composer-panel-header relative flex min-h-9 w-full min-w-0 items-center gap-2 rounded-t-2xl px-4 py-1.5 text-left text-sm/5 focus-ring hover:bg-zinc-950/2.5 sm:min-h-8 sm:text-[0.8125rem]/5 dark:hover:bg-white/4", className]}
  aria-expanded={expanded} aria-controls={controls}
  onpointerdown={() => { pressedExpanded = expanded; }}
  onpointercancel={() => { pressedExpanded = undefined; }}
  onclick={(event) => { const wasExpanded = event.detail ? (pressedExpanded ?? expanded) : expanded; pressedExpanded = undefined; onclick(wasExpanded); }}>
  {@render children()}
  <Icon name="chevron-down" size="xs" class={["t-acc-chevron ml-auto fill-zinc-400 dark:fill-zinc-500", expanded && "rotate-180"]} />
  <TouchTarget size="sm" />
</button>
