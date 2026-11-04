<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import { bareControlClasses, controlClasses, useField } from "./field.ts";
  import DateTimeControl from "./DateTimeControl.svelte";
  import NumberControl from "./NumberControl.svelte";
  import ChoiceControl from "./ChoiceControl.svelte";
  import type { DateTimeKind } from "./date-time.ts";

  /**
   * Shared input control. Inside a `Field`, id and descriptions come from it.
   * `bare`: no box of its own, for inputs inside another surface (a picker's search field).
   * `choice`: radio/checkbox; controlled through checked/onchange, without a text-value binding.
   */
  type Props = Omit<HTMLInputAttributes, "class"> & {
    class?: ClassValue;
    value?: HTMLInputAttributes["value"];
    bare?: boolean;
    choice?: boolean;
  };

  let { class: className, value = $bindable(), bare = false, choice = false, type = "text", ...rest }: Props = $props();
  const field = useField();
</script>

{#if type === "number"}
  <NumberControl {...rest} bind:value class={className} />
{:else if type === "datetime-local" || type === "date" || type === "time"}
  <DateTimeControl {...rest} type={type as DateTimeKind} bind:value class={className} />
{:else if choice}
  <ChoiceControl
    id={field?.id}
    aria-describedby={field?.describedBy}
    aria-invalid={field?.invalid || undefined}
    class={className}
    type={type === "radio" ? "radio" : "checkbox"}
    {value}
    {...rest}
  />
{:else}
  <input
    {type}
    id={field?.id}
    aria-describedby={field?.describedBy}
    aria-invalid={field?.invalid || undefined}
    class={[bare ? bareControlClasses : controlClasses, className]}
    bind:value
    {...rest}
  />
{/if}
