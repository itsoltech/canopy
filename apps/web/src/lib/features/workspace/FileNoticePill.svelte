<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import type { FileNotice } from "./file-notice.ts";

  /**
   * The file bar's notice slot: one compact pill beside the controls, so a notice never moves the text below.
   * In a narrow bar only the icon and the action stay; the sentence is in the tooltip.
   */
  let { notice }: { notice: FileNotice } = $props();
</script>

<span
  role="status"
  class="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-full bg-zinc-950/5 pr-1 pl-1.5 text-xs text-muted dark:bg-white/10"
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <span
    tabindex="0"
    class="flex min-w-0 items-center gap-1.5 rounded-full focus-ring"
    aria-label={notice.detail ?? notice.text}
    {@attach tooltip(notice.detail ?? notice.text)}
  >
    {#if notice.busy}<Spinner class="size-3.5" />{:else}<Icon name="information-circle" size="sm" />{/if}
    {#key notice.text}<span class="t-swap hidden min-w-0 truncate pr-0.5 @lg:inline">{notice.text}</span>{/key}
  </span>
  {#if notice.action}<button
      type="button"
      class="shrink-0 rounded-full px-1.5 font-medium whitespace-nowrap text-zinc-700 focus-ring hover:bg-zinc-950/5 dark:text-zinc-200 dark:hover:bg-white/10"
      onclick={notice.action.run}>{notice.action.label}</button
    >{/if}
</span>
