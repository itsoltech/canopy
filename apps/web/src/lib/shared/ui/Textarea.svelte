<script lang="ts">
  import type { ClassValue, HTMLTextareaAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";

  type Props = Omit<HTMLTextareaAttributes, "class"> & { class?: ClassValue; value?: HTMLTextareaAttributes["value"]; element?: HTMLTextAreaElement | undefined };
  let { class: className, value = $bindable(), element = $bindable(), ...rest }: Props = $props();
  const field = useField();
</script>

<textarea
  id={field?.id}
  aria-describedby={field?.describedBy}
  aria-invalid={field?.invalid || undefined}
  class={[controlClasses, "resize-y", className]}
  bind:value
  bind:this={element}
  {...rest}
></textarea>
