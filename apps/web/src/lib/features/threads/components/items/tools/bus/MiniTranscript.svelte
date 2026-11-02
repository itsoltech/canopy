<script lang="ts">
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { TranscriptLine } from "../agent-bus.ts";

  /**
   * What read_thread returned, as a small transcript: the user's messages as bubbles on the right, the
   * agent's on the left, other activity as quiet one-line rows. Long messages show their first lines;
   * more than `max` entries show the last ones until "Show all".
   */
  let { lines, max = 8 }: { lines: readonly TranscriptLine[]; max?: number } = $props();
  let all = $state(false);
  const shown = $derived(all || lines.length <= max ? lines : lines.slice(-max));
</script>

<div class="grid gap-2">
  {#if lines.length > max}
    <div class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <MoreButton expanded={all} onclick={() => (all = !all)}>{all ? `Show the last ${max} only` : `Show ${lines.length - max} earlier`}</MoreButton>
    </div>
  {/if}
  <ol role="list" class="grid gap-1.5" aria-label="Transcript">
    {#each shown as line (line.key)}
      {#if line.role === "activity"}
        <li class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
          <Icon name="wrench" class="size-3.5 shrink-0 fill-zinc-400 dark:fill-zinc-500" />
          <span class={["truncate", line.mono && "font-mono"]} title={line.text}>{line.text}</span>
        </li>
      {:else}
        <li class={["flex", line.role === "user" && "justify-end"]}>
          <p
            class={[
              "line-clamp-4 max-w-[85%] rounded-xl px-3 py-1.5 text-base/6 text-pretty break-words whitespace-pre-line sm:text-sm/6",
              line.role === "user" ? "bg-zinc-950/5 text-zinc-900 dark:bg-white/10 dark:text-zinc-100" : "text-zinc-700 ring-1 ring-zinc-950/10 ring-inset dark:text-zinc-300 dark:ring-white/10",
            ]}
          >
            <span class="sr-only">{line.role === "user" ? "User: " : "Agent: "}</span>{line.text}
          </p>
        </li>
      {/if}
    {/each}
  </ol>
</div>
