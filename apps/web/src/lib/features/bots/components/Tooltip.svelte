<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * Smallest possible tooltip: shows `text` while the wrapped control is hovered or has keyboard
   * focus. The control gets the tooltip's id for `aria-describedby` through the snippet argument.
   * Local stand-in until the shared kit's Tooltip lands; swap it there.
   */
  let {
    text,
    side = "bottom",
    align = "center",
    children,
    class: className,
  }: { text: string; side?: "top" | "bottom"; align?: "center" | "end"; children: Snippet<[string]>; class?: ClassValue } = $props();
  const id = $props.id();
</script>

<span class={["group/tip relative inline-flex", className]}>
  {@render children(id)}
  <span
    {id}
    role="tooltip"
    class={[
      "pointer-events-none absolute z-30 w-max max-w-48 rounded-md bg-zinc-950 px-2 py-1 text-xs/5 font-medium text-white opacity-0 shadow-lg group-hover/tip:opacity-100 group-has-focus-visible/tip:opacity-100 dark:bg-zinc-800 dark:shadow-none dark:ring-1 dark:ring-white/10",
      side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
      align === "center" ? "left-1/2 -translate-x-1/2" : "right-0",
    ]}
  >
    {text}
  </span>
</span>
