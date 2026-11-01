<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";

  /** Every `<input>` type that renders as a text box. Inside a `Field`, id and descriptions come from it. */
  type Props = Omit<HTMLInputAttributes, "class"> & { class?: ClassValue; value?: HTMLInputAttributes["value"] };
  let { class: className, value = $bindable(), ...rest }: Props = $props();
  const field = useField();
</script>

<input
  id={field?.id}
  aria-describedby={field?.describedBy}
  aria-invalid={field?.invalid || undefined}
  class={[controlClasses, className]}
  bind:value
  {...rest}
/>
