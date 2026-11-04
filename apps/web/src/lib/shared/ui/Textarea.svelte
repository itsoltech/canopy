<script lang="ts">
  import type { ClassValue, HTMLTextareaAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";

  /** `resize`: the user can drag its height (default); off for fields that grow with their content. */
  type Props = Omit<HTMLTextareaAttributes, "class"> & {
    class?: ClassValue;
    value?: HTMLTextareaAttributes["value"];
    element?: HTMLTextAreaElement | undefined;
    resize?: boolean;
  };

  let { class: className, value = $bindable(), element = $bindable(), resize = true, ...rest }: Props = $props();
  const field = useField();
</script>

<textarea
  id={field?.id}
  aria-describedby={field?.describedBy}
  aria-invalid={field?.invalid || undefined}
  class={[controlClasses, "ui-control", resize ? "resize-y" : "resize-none", className]}
  bind:value
  bind:this={element}
  {...rest}></textarea>
