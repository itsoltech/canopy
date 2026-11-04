<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  let {
    title,
    description,
    children,
    class: className,
  }: { title: string; description?: string; children: Snippet; class?: ClassValue } = $props();

  const id = $props.id();
</script>

<section aria-labelledby={id} class={["grid gap-3", className]}>
  <div class="grid gap-1">
    <h3 {id} class="text-base font-medium text-zinc-950 sm:text-sm dark:text-white">{title}</h3>
    {#if description}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
        {description}
      </p>{/if}
  </div>
  {@render children()}
</section>
