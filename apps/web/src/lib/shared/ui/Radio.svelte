<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import ChoiceControl from "./ChoiceControl.svelte";

  /** Radio button (the input only; pair it with a label). Checked state is yours: `checked` + `onchange`. */
  type Props = Omit<HTMLInputAttributes, "type" | "class"> & { class?: ClassValue };
  let { class: className, ...rest }: Props = $props();
</script>

<ChoiceControl
  type="radio"
  class={className}
  {...rest}
/>
