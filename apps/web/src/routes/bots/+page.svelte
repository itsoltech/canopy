<script lang="ts">
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /**
   * Home of the Bots section. Bots (agents that live in the gateway, not on a worker) are not built
   * yet, so this says what they will be and shows nothing made up.
   */
</script>

<svelte:head><title>Bots · Open Agents</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar><Crumb>Bots</Crumb></TopBar>
  <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto p-6">
    <div class="flex max-w-md flex-col items-center text-center">
      <Icon name="chat-bubble-left-right" class="fill-zinc-400 dark:fill-zinc-500" />
      <h1 class="mt-3 text-2xl font-semibold tracking-tight text-balance">Bots are on their way</h1>
      <p class="mt-2 text-base/7 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Bots live in the gateway, not in a project on a worker. You will chat with one, bring several into a group, or watch two of them work something out,
        and they will run routines and ask you when they need a decision. They will appear here once the gateway has them.
      </p>
    </div>
  </div>
</div>
