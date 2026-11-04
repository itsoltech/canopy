<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "./IconButton.svelte";

  let {
    label,
    decrease,
    increase,
    decreaseDisabled = false,
    increaseDisabled = false,
    class: className,
  }: {
    label: string;
    decrease: () => void;
    increase: () => void;
    decreaseDisabled?: boolean;
    increaseDisabled?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<div class={["flex shrink-0 items-center gap-1 pointer-coarse:gap-6", className]}>
  <IconButton icon="minus" label="Decrease {label}" size="sm" disabled={decreaseDisabled} onclick={decrease} />
  <IconButton icon="plus" label="Increase {label}" size="sm" disabled={increaseDisabled} onclick={increase} />
</div>
