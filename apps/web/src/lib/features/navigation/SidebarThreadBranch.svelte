<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /**
   * The thread's live git branch in the sidebar row's meta line (docs/threads.md, "Wiersz wątku"). A long name loses
   * its middle: the start (type prefix, topic) ellipsizes, the last characters stay whole, so `feat/a…-row` and
   * `feat/a…-api` remain distinct. The full name is the title (the row's hover card is the floating layer) and the
   * accessible name.
   */
  let { branch, label, class: className }: { branch: string; label: string; class?: ClassValue } = $props();
  const split = $derived(branch.length - Math.min(8, Math.floor(branch.length / 2)));
</script>

<span class={["flex min-w-0 items-center gap-1", className]} title={label}>
  <Icon name="git-fork" size="sm" class="shrink-0" />
  <span class="flex min-w-0 whitespace-pre" aria-hidden="true"
    ><span class="min-w-0 truncate">{branch.slice(0, split)}</span><span class="shrink-0">{branch.slice(split)}</span
    ></span
  >
  <span class="sr-only">{label}</span>
</span>
