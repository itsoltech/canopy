<script lang="ts">
  import type { Snippet } from "svelte";
  import { ItemStatus, type Subagent } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { humanizeToolName } from "@canopy/domain/humanize";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import TaskProgressText from "./TaskProgressText.svelte";

  /** The provider's own subagent (inside this thread, not a side thread): prompt, nested work, result. */
  let { agent, status, nested }: { agent: Subagent; status: ItemStatus; nested?: Snippet | undefined } = $props();
</script>

<ItemFrame icon="user-group" {status}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5">
      <span class="shrink-0 text-zinc-800 dark:text-zinc-200">{humanizeToolName(agent.agentType) || "Subagent"}</span>
      {#if agent.description}<span class="truncate">{agent.description}</span>{/if}
    </span>
  {/snippet}
  {#snippet aside()}
    {#if agent.background}<Badge>Background</Badge>{/if}
    <TaskProgressText progress={agent.progress} />
  {/snippet}
  {#if agent.prompt}
    <div class="rounded-lg bg-zinc-950/2.5 p-3 dark:bg-white/5">
      <p class="mb-1 text-sm/5 font-medium text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        Prompt{agent.model ? ` · ${agent.model}` : ""}
      </p>
      <Markdown text={agent.prompt} />
    </div>
  {/if}
  {#if nested}<div class="grid gap-1 border-l-2 border-zinc-950/5 pl-3 dark:border-white/10">
      {@render nested()}
    </div>{/if}
  {#if agent.result}
    <div>
      <p class="mb-1 text-sm/5 font-medium text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Result</p>
      <Markdown text={agent.result} />
    </div>
  {/if}
</ItemFrame>
