<script lang="ts">
  import { NoticeLevel } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { humanizeEnum } from "#lib/shared/humanize.ts";
  import type { TimelineNotice } from "../thread-state.svelte.ts";

  /** Platform or provider notice (rate limit, retry, restart, provider error). */
  let { notice }: { notice: TimelineNotice } = $props();
  const level = $derived(notice.notice.level);
</script>

<div
  class={[
    "flex items-start gap-2 rounded-lg px-3 py-2 text-base/6 sm:text-sm/6",
    level === NoticeLevel.ERROR ? "bg-rose-50 text-rose-900 dark:bg-rose-400/10 dark:text-rose-200" : level === NoticeLevel.WARNING ? "bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200" : "bg-zinc-950/2.5 text-zinc-700 dark:bg-white/5 dark:text-zinc-300",
  ]}
  role={level === NoticeLevel.ERROR ? "alert" : undefined}
>
  <span class="flex h-lh items-center">
    <Icon name={level === NoticeLevel.ERROR ? "exclamation-circle" : level === NoticeLevel.WARNING ? "exclamation-triangle" : "information-circle"} class="opacity-70" />
  </span>
  <!-- The machine code (e.g. rate_limit) stays in the tooltip; the message says it in words. -->
  <p class="min-w-0 break-words" title={notice.notice.code ? `Code: ${notice.notice.code}` : undefined}>
    {notice.notice.message || humanizeEnum(notice.notice.code)}
  </p>
</div>
