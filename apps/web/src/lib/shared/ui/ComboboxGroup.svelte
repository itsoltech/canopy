<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import { listboxHeadingClasses } from "./listbox.ts";
  import { expand } from "./motion.ts";

  let {
    label,
    expanded,
    inline,
    ontoggle,
    children,
    class: className,
  }: {
    label: string | undefined;
    expanded: boolean | undefined;
    inline: boolean;
    ontoggle: () => void;
    children: Snippet;
    class?: ClassValue;
  } = $props();

  const id = $props.id();

  function reveal(node: HTMLElement) {
    return expanded === undefined ? { duration: 0 } : expand(node, { instantReduced: true });
  }
</script>

{#if label}
  <li role="presentation" class={[listboxHeadingClasses, inline ? "-mx-1.5 px-4" : "-mx-1 px-3.5", className]}>
    {#if expanded !== undefined}
      <button
        type="button"
        class="flex min-h-9 w-full items-center gap-2 rounded-md text-left focus-ring sm:min-h-8"
        aria-expanded={expanded}
        aria-controls={id}
        onclick={ontoggle}
      >
        <span class="min-w-0 flex-1 truncate">{label}</span>
        <Icon name="chevron-right" class={["t-acc-chevron shrink-0", expanded && "rotate-90"]} />
      </button>
    {:else}
      <div class="truncate">{label}</div>
    {/if}
  </li>
{/if}
<li role="presentation" {id} inert={expanded === false}>
  {#if expanded !== false}
    <ul role="group" aria-label={label} class="grid grid-cols-1 content-start" transition:reveal>
      {@render children()}
    </ul>
  {/if}
</li>
