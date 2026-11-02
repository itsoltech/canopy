<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { useThreadActions } from "../thread-actions.svelte.ts";

  let { thread, parent, class: className }: { thread: ui.Thread; parent?: ui.Thread | undefined; class?: ClassValue } = $props();
  const actions = useThreadActions();
  let restoring = $state(false);
  async function unarchive() { restoring = true; try { await actions.run("archive", thread); } finally { restoring = false; } }
</script>

<section aria-label="Archived thread" class={["flex min-h-44 flex-col justify-center gap-4 rounded-2xl bg-zinc-950/3 p-4 ring-1 ring-zinc-950/8 sm:p-5 dark:bg-white/3 dark:ring-white/8", className]}>
  <div class="flex items-start gap-3">
    <Icon name="archive-box" class="h-6 fill-zinc-400 dark:fill-zinc-500" />
    <div class="min-w-0 flex-1">
      <h2 class="font-medium text-balance text-zinc-800 dark:text-zinc-200">This thread is archived</h2>
      <p class="pt-1 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        {#if thread.archivedBy === "user"}Archived by you{:else if thread.archivedBy === "agent"}Archived by the agent in “{thread.archivedByThreadTitle || parent?.title || 'the parent thread'}”{:else}Archived{/if}{#if thread.archivedAt} <time datetime={isoDateTime(thread.archivedAt)} title={formatDateTime(thread.archivedAt)}>{formatRelative(thread.archivedAt, clock.now)}</time>{/if}.
        The conversation is here whenever you need it.
      </p>
    </div>
  </div>
  <div class="flex flex-wrap gap-2">
    <Button size="sm" icon="arrow-uturn-left" loading={restoring} onclick={unarchive}>Unarchive</Button>
    {#if thread.parentThreadId}<ButtonLink size="sm" href="/threads/{thread.parentThreadId}" icon="arrow-turn-up-right">Open parent thread</ButtonLink>{/if}
  </div>
</section>
