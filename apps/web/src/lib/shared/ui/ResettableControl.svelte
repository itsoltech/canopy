<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SettingAction from "./SettingAction.svelte";

  /** Reset stays on the inner side of the alignment edge; each layout's DOM follows its visual order. */
  let {
    changed,
    reset,
    children,
    align = "responsive",
    class: className,
  }: {
    changed: boolean;
    reset: Snippet;
    children: Snippet;
    align?: "responsive" | "start" | "end";
    class?: ClassValue;
  } = $props();
</script>

<div class={["flex max-w-full min-w-0 items-center gap-2", className]}>
  {#if align !== "start"}
    <SettingAction active={changed} class={[align === "responsive" && "max-sm:hidden"]}>
      {@render reset()}
    </SettingAction>
  {/if}
  <div class="flex min-w-0 items-center gap-2">{@render children()}</div>
  {#if align !== "end"}
    <SettingAction active={changed} class={[align === "responsive" && "sm:hidden"]}>
      {@render reset()}
    </SettingAction>
  {/if}
</div>
