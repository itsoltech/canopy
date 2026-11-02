<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { useThreadDirectory } from "../../thread-directory.ts";

  /**
   * A message this thread's agent sent with send_message (docs/agent-bus.md), as its timeline shows it: the target
   * thread (any of yours, also in another project or on another worker), how it went (queued as the next turn or
   * steered into the running one) and the live status of the turn it reached, linking to that thread.
   * `sentDelivery` is what the call returned, until the stream reports the delivery (ThreadState.deliveries).
   */
  let {
    callId,
    threadId,
    sentDelivery,
    class: className,
  }: {
    callId: string;
    threadId: string;
    sentDelivery: string;
    class?: ClassValue;
  } = $props();

  const directory = useThreadDirectory();
  const overview = useOverview();
  const target = $derived(directory.thread(threadId));
  const delivery = $derived(directory.delivery?.(callId));
  const how = $derived(delivery?.delivery || sentDelivery || "queue");
  const status = $derived(delivery?.status || "queued");
  const look = $derived(status === "steering" ? { label: "Steering into its turn…", tone: "sky" as const, active: true } : statusLook(status));
  // Where it lives, when that is not here: its project and worker.
  const current = $derived(directory.thread(directory.currentId));
  const place = $derived.by(() => {
    if (!target || !current) return "";
    const project = target.projectId !== current.projectId ? overview?.project(target.projectId)?.name : undefined;
    const worker = target.workerId && target.workerId !== current.workerId ? overview?.worker(target.workerId)?.name : undefined;
    return [project, worker && `on ${worker}`].filter(Boolean).join(" · ");
  });
</script>

<a
  href="/threads/{threadId}"
  class={[
    "grid gap-1 rounded-lg border border-violet-600/15 bg-white p-3 hover:bg-violet-50/60 focus-ring dark:border-violet-400/15 dark:bg-zinc-950 dark:hover:bg-violet-400/5",
    className,
  ]}
>
  <div class="flex min-w-0 items-center gap-2">
    <Icon name="chat-bubble-left-right" class="fill-violet-500 dark:fill-violet-400" />
    <p class="min-w-0 flex-1 truncate text-base/6 font-medium text-zinc-900 sm:text-sm/6 dark:text-zinc-100">
      <span class="sr-only">Message to </span>{target?.title || "Another thread"}
    </p>
    {#if place}<p class="max-w-40 shrink-0 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{place}</p>{/if}
    <Icon name="chevron-right" class="fill-zinc-400 dark:fill-zinc-500" />
  </div>
  <p class="flex min-w-0 items-center gap-1.5 pl-6 text-sm/5 text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
    <span class="shrink-0">{how === "steer" ? "Steered into its running turn" : "Queued as its next turn"}</span>
    <span aria-hidden="true">·</span>
    {#key look.label}
      <span class="flex min-w-0 items-center gap-1.5" in:swap><StatusDot tone={look.tone} active={look.active} /><span class="truncate">{look.label}</span></span>
    {/key}
  </p>
</a>
