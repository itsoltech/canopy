<script lang="ts">
  import { NoticeLevel } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { noticePresentation } from "@canopy/domain/notice-presentation";
  import type { TimelineNotice } from "../thread-state.svelte.ts";

  /** Platform or provider notice (rate limit, retry, restart, provider error). */
  let { notice }: { notice: TimelineNotice } = $props();
  const presentation = $derived(noticePresentation(notice.notice, notice));
  const level = $derived(presentation.level ?? notice.notice.level);
</script>

<div
  class={[
    "density-work flex min-w-0 items-start gap-2 text-base/6 sm:text-sm/5",
    notice.recovered
      ? "py-1 text-amber-800 dark:text-amber-200"
      : level === NoticeLevel.ERROR
        ? "rounded-lg bg-rose-50 px-3 py-2 text-rose-900 dark:bg-rose-400/10 dark:text-rose-200"
        : level === NoticeLevel.WARNING
          ? "rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200"
          : "rounded-lg bg-zinc-950/2.5 px-3 py-2 text-zinc-700 dark:bg-white/5 dark:text-zinc-300",
  ]}
  role={level === NoticeLevel.ERROR ? "alert" : undefined}
>
  <span class="flex h-lh shrink-0 items-center">
    <Icon
      name={level === NoticeLevel.ERROR
        ? "exclamation-circle"
        : level === NoticeLevel.WARNING
          ? "exclamation-triangle"
          : "information-circle"}
      class="opacity-70"
    />
  </span>
  <div class="grid min-w-0 flex-1 gap-1">
    <p class="wrap-anywhere select-text" title={notice.notice.code ? `Code: ${notice.notice.code}` : undefined}>
      {presentation.message}
      {#if presentation.count > 1}<span class="whitespace-nowrap tabular-nums"> ×{presentation.count}</span>{/if}
    </p>
    {#if presentation.details}
      <Disclosure remember={`notice:${notice.seq}`} class="min-w-0">
        {#snippet summary()}Show details{/snippet}
        <div class="flex min-w-0 items-start gap-2 py-1 text-sm/5 sm:text-xs/5">
          <pre
            class="min-w-0 flex-1 font-mono wrap-anywhere whitespace-pre-wrap select-text">{presentation.details}</pre>
          <CopyButton text={presentation.details} label="Copy error details" />
        </div>
      </Disclosure>
    {/if}
  </div>
</div>
