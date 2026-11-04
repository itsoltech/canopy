<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import ScheduleStatus from "./ScheduleStatus.svelte";

  /**
   * A task's name with its status, then its message: two lines each, with "Show all" when either runs longer,
   * so the whole text is readable without hovering. Long unbroken strings (links, paths) wrap anywhere.
   */
  let { schedule }: { schedule: ui.Schedule } = $props();

  const prompt = $derived(schedule.name && schedule.name !== schedule.prompt ? schedule.prompt : undefined);
  let all = $state(false);
  let clamped = $state(false);
  let title = $state<HTMLElement>();
  let message = $state<HTMLElement>();

  $effect(() => {
    if (all) return;
    const texts = [title, message].filter((text) => text !== undefined);

    const observer = new ResizeObserver(() => {
      clamped = texts.some((text) => text.scrollHeight > text.clientHeight + 1);
    });

    for (const text of texts) observer.observe(text);

    return () => observer.disconnect();
  });
</script>

<div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
  <p
    bind:this={title}
    class={[
      "min-w-0 text-base/6 font-medium wrap-anywhere text-zinc-950 sm:text-sm/6 dark:text-white",
      !all && "line-clamp-2",
    ]}
  >
    {schedule.name || schedule.prompt}
  </p>
  <ScheduleStatus status={schedule.status} />
</div>
{#if prompt}<p
    bind:this={message}
    class={["text-base/6 wrap-anywhere text-zinc-500 sm:text-sm/6 dark:text-zinc-400", !all && "line-clamp-2"]}
  >
    {prompt}
  </p>{/if}
{#if clamped}<MoreButton expanded={all} onclick={() => (all = !all)}>{all ? "Show less" : "Show all"}</MoreButton>{/if}
