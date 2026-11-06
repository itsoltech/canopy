<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ApprovalView } from "@canopy/domain/bot-chat";
  import BotAvatar from "./BotAvatar.svelte";

  let { proposal, class: className }: { proposal: NonNullable<ApprovalView["botProposal"]>; class?: ClassValue } =
    $props();

  const id = $props.id();

  const details = $derived([
    { label: "Model", value: proposal.model },
    { label: "Effort", value: proposal.effort || "Model default" },
    { label: "Instance", value: `${proposal.provider} · ${proposal.instance}` },
    {
      label: "Approval",
      value:
        proposal.approvalPolicy === "always"
          ? "Ask before every action"
          : proposal.approvalPolicy === "full_auto"
            ? "Full auto: protected actions ask"
            : "Ask before sensitive actions",
    },
  ]);
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <div class="flex min-w-0 items-center gap-3">
    <BotAvatar
      participant={{ id, kind: "bot", name: proposal.name, shape: proposal.shape, color: proposal.color }}
      size="lg"
    />
    <div class="grid min-w-0 gap-0.5">
      <p class="font-medium wrap-anywhere text-zinc-950 dark:text-white">{proposal.name}</p>
      <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        A new bot in Canopy, with its own conversation.
      </p>
    </div>
  </div>
  <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-base/6 sm:text-sm/6">
    {#each details as detail (detail.label)}
      <dt class="font-medium text-zinc-800 dark:text-zinc-200">{detail.label}</dt>
      <dd class="min-w-0 wrap-anywhere text-zinc-600 dark:text-zinc-400">{detail.value}</dd>
    {/each}
  </dl>
  <div class="grid min-w-0 gap-2">
    <p id="{id}-instructions" class="text-base/6 font-medium text-zinc-800 sm:text-sm/6 dark:text-zinc-200">
      Standing instructions
    </p>
    <!-- Keyboard users need to focus this scroll region to read long instructions. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      role="region"
      aria-labelledby="{id}-instructions"
      tabindex="0"
      class="max-h-48 overflow-y-auto overscroll-contain rounded-xl bg-zinc-950/3 p-3 text-base/6 wrap-anywhere whitespace-pre-wrap text-zinc-700 focus-ring sm:text-sm/6 dark:bg-white/5 dark:text-zinc-300"
    >
      {proposal.instructions || "No additional instructions."}
    </div>
  </div>
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Creating a bot always needs your approval. Its replies use the selected model and may incur costs.
  </p>
</div>
