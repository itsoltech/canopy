<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { useRemembered } from "./memory.ts";
  import { expand, expandGrid } from "./motion.ts";

  /**
   * Native `<details>`: keyboard and screen-reader support without script. The summary is a full-width
   * row with a rotating chevron; `open` is bindable so callers can expand on events (e.g. a failure).
   * The content grows in and shrinks out (accordion, motion.ts `expand`); remounted rows open without it.
   * `remember` names it in the surrounding UI memory (rows of a virtual list): remounted, it opens as it was.
   * `align="center"` centres the chevron on a multi-line summary (a card row) instead of its first line.
   */
  let {
    open = $bindable(false),
    remember,
    onchange,
    align = "start",
    grid = false,
    class: className,
    summaryClass,
    summary,
    children,
  }: {
    open?: boolean;
    remember?: string;
    onchange?: ((open: boolean) => void) | undefined;
    align?: "start" | "center";
    /** Grid accordion for contained activity surfaces; closed bodies still unmount. */
    grid?: boolean;
    class?: ClassValue;
    summaryClass?: ClassValue;
    summary: Snippet;
    children: Snippet;
  } = $props();

  const memory = untrack(() => (remember ? useRemembered<boolean>(remember) : undefined));
  const saved = memory?.get();

  if (saved !== undefined) open = saved;

  $effect(() => memory?.set(open));

  function accordion(node: HTMLElement) {
    return grid ? expandGrid() : expand(node, { instantReduced: true });
  }
</script>

<details
  class={["t-acc group/disclosure", className]}
  bind:open
  ontoggle={(event) => onchange?.(event.currentTarget.open)}
>
  <summary
    class={[
      "flex cursor-pointer list-none gap-2 rounded-md focus-ring select-none",
      align === "center" ? "items-center" : "items-start",
      summaryClass,
    ]}
  >
    <span class={["flex items-center", align === "start" && "h-lh"]}>
      <Icon
        name="chevron-right"
        class="t-acc-chevron fill-zinc-400 group-open/disclosure:rotate-90 dark:fill-zinc-500"
      />
    </span>
    <span class="min-w-0 flex-1">{@render summary()}</span>
  </summary>
  {#if open}
    <div class={[grid && "grid grid-rows-[1fr]"]} transition:accordion>
      {#if grid}
        <div class="min-h-0 min-w-0 overflow-hidden">{@render children()}</div>
      {:else}{@render children()}{/if}
    </div>
  {/if}
</details>
