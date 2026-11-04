<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import ProjectAvatar from "./ProjectAvatar.svelte";

  /** Project identity shared by pickers, sidebar rows and thread summaries. */
  let { name, kind, class: className }: { name: string; kind?: string | undefined; class?: ClassValue } = $props();
</script>

{#if kind === "scratch"}
  <span
    class={[
      "inline-block size-4.5 shrink-0 rounded-sm border border-dashed border-zinc-500 dark:border-zinc-400",
      className,
    ]}
    aria-hidden="true"
  ></span>
{:else}
  <ProjectAvatar {name} class={className} />
{/if}
