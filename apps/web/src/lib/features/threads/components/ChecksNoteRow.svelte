<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { checksNoteLine } from "@canopy/domain/pr-check-display";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /**
   * The platform told the agent how the CI checks of a linked pull request moved (a turn of its own, or a note steered
   * into the running turn; docs/agent-bus.md, "Checki CI"): one compact system line per note, linking to the pull
   * request. The note's full text is the agent's.
   */
  let { notes, class: className }: { notes: readonly ui.PullRequestChecksNote[]; class?: ClassValue } = $props();
</script>

<ul role="list" class={["flex flex-col gap-1", className]}>
  {#each notes as note, index (`${note.watchId}:${index}`)}
    {@const line = checksNoteLine(note)}
    <li class="flex items-start gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <span class="flex h-lh shrink-0 items-center"
        ><Icon
          name={line.icon}
          tone={line.tone === "neutral" ? "muted" : "inherit"}
          class={[
            "size-3.5",
            line.tone === "failed" && "text-rose-600 dark:text-rose-400",
            line.tone === "passed" && "text-emerald-600 dark:text-emerald-400",
          ]}
        /></span
      >
      <p class="min-w-0 break-words">
        <span>{line.text}</span>
        <span aria-hidden="true">·</span>
        <a
          href={note.url}
          target="_blank"
          rel="noreferrer"
          class="rounded-sm font-medium text-zinc-700 underline decoration-zinc-950/20 underline-offset-2 focus-ring hover:decoration-zinc-950/50 dark:text-zinc-300 dark:decoration-white/20 dark:hover:decoration-white/50"
          >{line.pullRequest}</a
        >
        {#if line.commit}
          <span aria-hidden="true">·</span>
          <span>{line.commit}</span>
        {/if}
      </p>
    </li>
  {/each}
</ul>
