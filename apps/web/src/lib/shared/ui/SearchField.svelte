<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";

  /**
   * Search box with a magnifier: a framed label around a bare `type="search"` input. `label` is the accessible
   * name (visually hidden); other input attributes (name, placeholder, data-autofocus) pass through.
   */
  type Props = Omit<HTMLInputAttributes, "class" | "type" | "value"> & {
    label: string;
    value?: string;
    class?: ClassValue;
  };

  let { label, value = $bindable(""), class: className, ...rest }: Props = $props();
</script>

<label
  class={[
    "flex items-center gap-2 rounded-lg px-2.5 py-2 ring-1 ring-zinc-950/10 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 sm:py-1.5 dark:ring-white/10",
    className,
  ]}
>
  <Icon name="magnifying-glass" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
  <span class="sr-only">{label}</span>
  <input
    type="search"
    bind:value
    autocomplete="off"
    class="min-w-0 flex-1 bg-transparent text-base/6 text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400"
    {...rest}
  />
</label>
