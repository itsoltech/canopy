<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { provideField } from "./field.ts";
  import FieldError from "./FieldError.svelte";
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
    layout = "stack",
    class: className,
    children,
  }: {
    label: string;
    description?: string;
    error?: string | undefined;
    optional?: boolean;
    /** Row fields stack again when their settings form is narrower than 28rem. */
    layout?: "stack" | "row";
    class?: ClassValue;
    children: Snippet;
  } = $props();

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

{#snippet heading()}
  <label
    for={id}
    class="flex items-baseline justify-between gap-2 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white"
  >
    {label}{#if optional}<span class="text-sm/6 font-normal text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
        >Optional</span
      >{/if}
  </label>
{/snippet}

{#snippet hint()}
  {#if description}<p id="{id}-description" class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
      {description}
    </p>{/if}
{/snippet}

<div class={[layout === "row" ? "ui-field-row" : "ui-field grid gap-1.5", className]}>
  {#if layout === "row"}
    <div class="min-w-0">{@render heading()}{@render hint()}</div>
    <div class="grid min-w-0 gap-1.5" {@attach shake(error)}>
      {@render children()}<FieldError id="{id}-error" message={error} />
    </div>
  {:else}
    {@render heading()}
    <div class="grid min-w-0 gap-1.5" {@attach shake(error)}>{@render children()}</div>
    {@render hint()}<FieldError id="{id}-error" message={error} />
  {/if}
</div>
