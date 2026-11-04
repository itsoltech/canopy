<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import TouchTarget from "./TouchTarget.svelte";

  /** Shared form-picker button. It owns padding/positioning; callers size its wrapper.
   * Popover attachments and combobox ARIA attributes pass through to the actual button. */
  type Props = Omit<HTMLButtonAttributes, "class" | "children"> & {
    text: string;
    icon: IconName;
    leadingIcon?: IconName | undefined;
    element?: HTMLButtonElement | undefined;
    class?: ClassValue;
  };

  let { text, icon, leadingIcon, element = $bindable(), class: className, ...rest }: Props = $props();
  const field = useField();
</script>

<button
  {...rest}
  bind:this={element}
  type="button"
  role="combobox"
  id={rest.id ?? field?.id}
  aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
  aria-invalid={rest["aria-invalid"] ?? (field?.invalid || undefined)}
  class={[controlClasses, "ui-control relative flex items-center gap-2 text-left pointer-coarse:min-h-12", className]}
>
  {#if leadingIcon}<Icon name={leadingIcon} />{/if}
  <span class="min-w-0 flex-1 truncate">{text}</span>
  <Icon name={icon} class="fill-zinc-500 dark:fill-zinc-400" />
  <TouchTarget />
</button>
