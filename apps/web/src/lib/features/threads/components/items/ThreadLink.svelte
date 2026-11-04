<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { useThreadDirectory } from "../../thread-directory.ts";

  /** Link to another thread of the project with its live status (title from the directory or a fallback). */
  let {
    threadId,
    fallback = "Thread",
    class: className,
  }: { threadId: string; fallback?: string; class?: ClassValue } = $props();

  const directory = useThreadDirectory();
  const thread = $derived(directory.thread(threadId));
  const look = $derived(thread ? statusLook(thread.status) : undefined);
</script>

<a
  href="/threads/{threadId}"
  class={[
    "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-violet-50 px-2 py-0.5 text-sm/5 font-medium text-violet-800 ring-1 ring-violet-600/20 focus-ring ring-inset hover:bg-violet-100 sm:text-xs/5 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/20 dark:hover:bg-violet-400/20",
    className,
  ]}
>
  {#if look}<StatusDot tone={look.tone} active={look.active} />{/if}
  <span class="truncate">{thread?.title || fallback}</span>
  {#if look}<span class="sr-only">({look.label})</span>{/if}
</a>
