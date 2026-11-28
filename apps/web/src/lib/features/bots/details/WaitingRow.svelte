<script lang="ts">
  import type { bots } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";

  /** A parked card from a background run: what it asks, where it came from, and a way to it in the chat. */
  let {
    item,
    onreveal,
    class: className,
  }: { item: bots.BotApproval; onreveal: () => void; class?: ClassValue } = $props();

  const asked = $derived(
    item.kind === "question"
      ? item.prompt
      : (item.prompt.split("\n", 1)[0] ?? "").replace(/^Needs approval · /, "") || "Approve an action",
  );

  const origin = $derived(
    `${item.kind === "question" ? "Question" : "Approval"} from ${
      item.routineTitle
        ? `${item.routineKind === "trigger" ? "event trigger" : "routine"} “${item.routineTitle}”`
        : "a reminder"
    }`,
  );
</script>

<li class={["flex items-start gap-3 py-4 first:pt-0 last:pb-0", className]}>
  <div class="grid min-w-0 flex-1 gap-1">
    <h4 class="line-clamp-2 font-medium text-pretty wrap-anywhere text-zinc-900 dark:text-zinc-100">{asked}</h4>
    <p class="text-pretty wrap-anywhere text-zinc-500 dark:text-zinc-400">{origin}</p>
  </div>
  <div class="shrink-0">
    <Button size="sm" variant="secondary" onclick={onreveal}>Show in chat</Button>
  </div>
</li>
