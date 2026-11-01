<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { provideField } from "./field.ts";
  import { shake } from "./motion.ts";

  /**
   * Label, control, hint and error. The control inside (Input, Select, Textarea) picks up the id,
   * aria-describedby and aria-invalid from context. A new error shakes the control.
   */
  let {
    label,
    description,
    error,
    optional = false,
    class: className,
    children,
  }: { label: string; description?: string; error?: string | undefined; optional?: boolean; class?: ClassValue; children: Snippet } = $props();

  const id = $props.id();
  provideField({
    id,
    get describedBy() {
      return [description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
    },
    get invalid() {
      return Boolean(error);
    },
  });
</script>

<div class={["grid gap-1.5", className]}>
  <label for={id} class="flex items-baseline justify-between gap-2 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
    {label}
    {#if optional}<span class="text-sm/6 font-normal text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Optional</span>{/if}
  </label>
  <div class="grid gap-1.5" {@attach shake(error)}>{@render children()}</div>
  {#if description}<p id="{id}-description" class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
  {#if error}<p id="{id}-error" class="text-sm/5 text-rose-700 dark:text-rose-400" role="alert">{error}</p>{/if}
</div>
