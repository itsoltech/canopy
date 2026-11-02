<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import { bareControlClasses, controlClasses, useField } from "./field.ts";

  /**
   * Every `<input>` type that renders as a text box. Inside a `Field`, id and descriptions come from it.
   * `bare`: no box of its own, for inputs inside another surface (a picker's search field).
   */
  type Props = Omit<HTMLInputAttributes, "class"> & { class?: ClassValue; value?: HTMLInputAttributes["value"]; bare?: boolean; choice?: boolean };
  let { class: className, value = $bindable(), bare = false, choice = false, ...rest }: Props = $props();
  const field = useField();
</script>

<input
  id={field?.id}
  aria-describedby={field?.describedBy}
  aria-invalid={field?.invalid || undefined}
  class={[choice ? "size-5 shrink-0 accent-brand-600 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50 sm:size-4 dark:accent-brand-500" : bare ? bareControlClasses : controlClasses, className]}
  bind:value
  {...rest}
/>
