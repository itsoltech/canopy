<script lang="ts">
  import { Provider, type bots } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { modelDisplayName } from "#lib/features/models/catalog.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { botParticipant } from "../live.ts";
  import { mascotFor, mascotShapes } from "../mascot.ts";
  import { stateForStatus } from "../behaviour-math.ts";
  import { openBotSettings } from "../settings/open.ts";
  import MascotFace from "../components/MascotFace.svelte";
  import DetailsSection from "./DetailsSection.svelte";
  import RoutineRow from "./RoutineRow.svelte";
  import ReminderRow from "./ReminderRow.svelte";
  import BotHome from "../components/BotHome.svelte";
  import { useBotHome } from "../home.svelte.ts";

  /** Section composition leaves a slot for Connections without coupling to the settings editor. */
  let {
    bot,
    routines,
    reminders,
    status = "",
    onclose,
    children,
    class: className,
  }: {
    bot: bots.Bot;
    routines: readonly bots.BotRoutine[];
    reminders: readonly bots.BotReminder[];
    status?: string;
    onclose: () => void;
    children?: Snippet;
    class?: ClassValue;
  } = $props();

  const participant = $derived(botParticipant(bot));
  const home = useBotHome(() => bot.nodeId);
  const config = $derived(bot.configuration!);
  const shape = $derived(mascotShapes.find((s) => s.id === config.shape)?.id);
  let busy = $state<Record<string, boolean>>({});
  let error = $state("");
  let removing = $state<bots.BotRoutine>();
  let confirming = $state(false);

  async function act(id: string, action: () => Promise<unknown>) {
    if (busy[id]) return;
    busy = { ...busy, [id]: true };
    error = "";

    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update this bot.";
    } finally {
      busy = { ...busy, [id]: false };
    }
  }

  function toggle(routine: bots.BotRoutine, enabled: boolean) {
    void act(routine.id, () => requestJson("PUT", `/api/bots/${bot.id}/routines/${routine.id}`, { enabled }));
  }

  async function remove() {
    if (!removing) return;
    const routine = removing;
    await act(routine.id, async () => {
      await requestJson("DELETE", `/api/bots/${bot.id}/routines/${routine.id}`);
      confirming = false;
      removing = undefined;
    });
  }
</script>

<div class={["flex min-h-full flex-col gap-8 px-5 pt-4 pb-8 text-base/6 sm:px-6 sm:text-sm/5", className]}>
  <div class="-mx-5 -mt-4 flex h-12 shrink-0 items-center justify-end px-2 sm:-mx-6" data-window-drag>
    <IconButton icon="x-mark" label="Close bot details" onclick={onclose} />
  </div>
  <div class="grid justify-items-center gap-4 pb-2 text-center">
    <MascotFace
      {shape}
      color={config.color}
      legacy={shape ? undefined : mascotFor(bot.id, config.shape)}
      state={status ? stateForStatus(status) : "idle"}
      event={bot.lastMessage?.id}
      label={participant.name}
      class="size-28"
    />
    <div class="grid max-w-full min-w-0 gap-1">
      <h2 class="text-xl font-semibold tracking-tight text-balance wrap-anywhere text-zinc-950 dark:text-white">
        {participant.name}
      </h2>
      <p class="text-pretty wrap-anywhere text-zinc-500 dark:text-zinc-400">
        {modelDisplayName(config.model)} · {config.provider === Provider.CODEX
          ? "Codex"
          : config.provider === Provider.GROK
            ? "Grok"
            : "Claude"}
      </p>
    </div>
    <BotHome nodeId={bot.nodeId} banner class="justify-center" />
    <Button
      size="sm"
      variant="secondary"
      icon="cog-6-tooth"
      disabled={Boolean(home.reason)}
      onclick={() => openBotSettings(bot.id)}>Bot settings</Button
    >
  </div>

  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <DetailsSection
    title="Routines"
    description={routines.length ? "Quietly in the background. Your bot decides when to reach out." : undefined}
  >
    {#if routines.length}
      <ul role="list" class="divide-y divide-zinc-950/6 dark:divide-white/8">
        {#each routines as routine (routine.id)}
          <RoutineRow
            {routine}
            busy={busy[routine.id] ?? false}
            disabled={bot.archived || Boolean(home.reason)}
            ontoggle={(enabled) => toggle(routine, enabled)}
            ondelete={() => {
              removing = routine;
              confirming = true;
            }}
          />
        {/each}
      </ul>
    {:else}
      <div class="grid gap-3 rounded-2xl bg-zinc-950/3 p-4 dark:bg-white/4">
        <p class="text-pretty text-zinc-600 dark:text-zinc-300">Ask {participant.name} to set up a routine.</p>
        <p class="text-pretty text-zinc-500 dark:text-zinc-400">
          “Every weekday at 9, check my projects and tell me only if something needs my attention.”
        </p>
      </div>
    {/if}
  </DetailsSection>
  {#if reminders.length}
    <DetailsSection title="Reminders">
      <ul role="list" class="grid gap-4">
        {#each reminders as reminder (reminder.id)}
          <ReminderRow
            {reminder}
            disabled={Boolean(home.reason)}
            busy={busy[reminder.id] ?? false}
            oncancel={() => {
              void act(reminder.id, () => requestJson("DELETE", `/api/bots/${bot.id}/reminders/${reminder.id}`));
            }}
          />
        {/each}
      </ul>
    </DetailsSection>
  {/if}
  {@render children?.()}
</div>

<Dialog
  bind:open={confirming}
  title="Delete routine?"
  description={removing
    ? `“${removing.title}” will stop running. Ask your bot to set it up again if you change your mind.`
    : undefined}
  dismissible={!removing || !busy[removing.id]}
>
  <div class="flex justify-end gap-2 pt-5">
    <Button variant="secondary" disabled={removing ? busy[removing.id] : false} onclick={() => (confirming = false)}
      >Keep routine</Button
    >
    <Button variant="danger" loading={removing ? busy[removing.id] : false} onclick={remove}>Delete routine</Button>
  </div>
  {#if error}<p role="alert" class="pt-3 text-base/6 text-rose-600 sm:text-sm/5 dark:text-rose-400">{error}</p>{/if}
</Dialog>
