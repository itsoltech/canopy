<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";

  /** Radio button (the input only; pair it with a label). Checked state is yours: `checked` + `onchange`. */
  type Props = Omit<HTMLInputAttributes, "type" | "class"> & { class?: ClassValue };
  let { class: className, ...rest }: Props = $props();
</script>

<input
  type="radio"
  class={[
    "size-5 shrink-0 appearance-none rounded-full border border-zinc-300 bg-white checked:border-[5px] checked:border-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:border-zinc-300 disabled:bg-zinc-100 sm:size-4 sm:checked:border-4 dark:border-white/10 dark:bg-white/5 dark:checked:border-brand-500 forced-colors:appearance-auto",
    className,
  ]}
  {...rest}
/>
