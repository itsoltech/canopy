<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue, HTMLSelectAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";

  /** Native `<select>` with a consistent chevron. Options go in as children. */
  type Props = Omit<HTMLSelectAttributes, "class" | "children"> & { class?: ClassValue; value?: unknown; children: Snippet };
  let { class: className, value = $bindable(), children, ...rest }: Props = $props();
  const field = useField();
</script>

<div class={["grid grid-cols-[1fr_--spacing(8)]", className]}>
  <select
    id={field?.id}
    aria-describedby={field?.describedBy}
    aria-invalid={field?.invalid || undefined}
    class={[controlClasses, "col-span-full row-start-1 appearance-none truncate pr-8"]}
    bind:value
    {...rest}
  >
    {@render children()}
  </select>
  <svg viewBox="0 0 8 5" width="8" height="5" fill="none" class="pointer-events-none col-start-2 row-start-1 place-self-center stroke-zinc-500 dark:stroke-zinc-400" aria-hidden="true">
    <path d="M.5.5 4 4 7.5.5" />
  </svg>
</div>
