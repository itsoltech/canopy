<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";

  /**
   * The thread's live git branch in the sidebar row's meta line. Long names lose their middle, so the type prefix
   * (`feat/`) and the distinguishing end stay visible; the full name is the title and the accessible name.
   */
  let { branch, class: className }: { branch: string; class?: ClassValue } = $props();
</script>

<span class={["flex min-w-0 items-center gap-1", className]}>
  <Icon name="git-fork" size="sm" class="shrink-0" />
  <span class="flex min-w-0" aria-hidden="true"><MiddleTruncatedText text={branch} hint="title" /></span>
  <span class="sr-only">Branch {branch}</span>
</span>
