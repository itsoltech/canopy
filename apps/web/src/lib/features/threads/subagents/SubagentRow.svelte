<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import ProviderModel from "../components/ProviderModel.svelte";
  import { subagentLook, type Subagent } from "./subagents.ts";

  /**
   * One subagent in the panel above the composer: its state, title, what it runs on and the start of its last
   * message, linking to its thread (where you can read it and write to it like to any thread).
   */
  let { subagent, class: className }: { subagent: Subagent; class?: ClassValue } = $props();
  const look = $derived(subagentLook(subagent.state));
  const thread = $derived(subagent.thread);
  const snippet = $derived(thread.lastMessage.trim().replace(/\s+/g, " "));
</script>

<a href="/threads/{thread.id}" class={["group/row grid gap-0.5 rounded-xl px-2.5 py-1.5 hover:bg-zinc-950/2.5 focus-ring dark:hover:bg-white/4", className]}>
  <div class="flex min-w-0 items-center gap-2">
    <StatusDot tone={look.tone} active={look.active} />
    <p class="min-w-0 flex-1 truncate text-base/6 text-zinc-900 sm:text-sm/6 dark:text-zinc-100">{thread.title}</p>
    <p class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <ProviderModel provider={thread.provider} model={thread.model} class="max-w-40 max-sm:hidden" />
      <span class="max-sm:hidden" aria-hidden="true">·</span>
      <span>{look.label}</span>
    </p>
    <Icon name="chevron-right" class="fill-zinc-400 dark:fill-zinc-500" />
  </div>
  <p class="truncate pl-4 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    {#if snippet}<span class="sr-only">Last message: </span>{snippet}{:else}<span class="italic">{subagent.state === "working" ? "Working on it…" : "No message yet"}</span>{/if}
  </p>
</a>
