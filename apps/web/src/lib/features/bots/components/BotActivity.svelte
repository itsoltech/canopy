<script lang="ts" module>
  import type { MascotState } from "../behaviour.ts";

  export interface BotActivityView {
    botId: string;
    state: MascotState;
    label?: string;
  }
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ParticipantView } from "../model.ts";
  import BotAvatar from "./BotAvatar.svelte";

  let {
    bot,
    state,
    label,
    event,
    class: className,
  }: {
    bot: ParticipantView;
    state: MascotState;
    label?: string | undefined;
    event?: unknown;
    class?: ClassValue;
  } = $props();

  const labels: Record<MascotState, string> = {
    idle: "",
    working: "Working…",
    typing: "Typing…",
    waiting: "Waiting for you",
    done: "Done",
    error: "Needs attention",
  };
</script>

<div class={["grid justify-items-start gap-1", className]}>
  <BotAvatar participant={bot} size="md" {state} {event} />
  <p role="status" class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{label ?? labels[state]}</p>
</div>
