<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import { bareControlClasses, controlClasses, useField } from "./field.ts";

  /**
   * Shared input control. Inside a `Field`, id and descriptions come from it.
   * `bare`: no box of its own, for inputs inside another surface (a picker's search field).
   * `choice`: radio/checkbox; controlled through checked/onchange, without a text-value binding.
   */
  type Props = Omit<HTMLInputAttributes, "class"> & { class?: ClassValue; value?: HTMLInputAttributes["value"]; bare?: boolean; choice?: boolean };
  let { class: className, value = $bindable(), bare = false, choice = false, ...rest }: Props = $props();
  const field = useField();
</script>

{#if choice}
  <input
    id={field?.id}
    aria-describedby={field?.describedBy}
    aria-invalid={field?.invalid || undefined}
    class={["size-5 shrink-0 accent-brand-600 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50 sm:size-4 dark:accent-brand-500", className]}
    {value}
    {...rest}
  />
{:else}
<input
  id={field?.id}
  aria-describedby={field?.describedBy}
  aria-invalid={field?.invalid || undefined}
  class={[bare ? bareControlClasses : controlClasses, className]}
  bind:value
  {...rest}
/>
{/if}
