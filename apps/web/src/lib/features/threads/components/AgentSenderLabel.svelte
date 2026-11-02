<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import ProviderModel from "./ProviderModel.svelte";
  import ThreadLink from "./items/ThreadLink.svelte";

  /**
   * Who sent an agent's input (a task, a message, a report, a steer): "<verb> <thread>" linking to the sender's
   * thread (also one in another tree, project or worker: its title comes with the sender), then what that agent
   * runs on. Inline, inside the violet line above the bubble.
   */
  let { verb, threadId, sender, fallback = "another thread" }: { verb: string; threadId: string; sender?: ui.AgentSender | undefined; fallback?: string } = $props();
</script>

{verb} <ThreadLink {threadId} fallback={sender?.title || fallback} />
{#if sender}<ProviderModel provider={sender.provider} model={sender.model} class="text-zinc-500 dark:text-zinc-400" />{/if}
