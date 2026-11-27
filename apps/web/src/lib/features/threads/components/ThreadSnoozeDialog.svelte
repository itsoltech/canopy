<script lang="ts">
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import { snoozeDeadline, snoozePresets } from "@canopy/domain/thread-snooze";
  import { tick } from "svelte";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime } from "#lib/shared/format.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import FieldError from "#lib/shared/ui/FieldError.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { localValue, parseDateTime } from "#lib/shared/ui/date-time.ts";
  import { restoreSnoozeFocus, useThreadActions } from "../thread-actions.svelte.ts";
  import { threadCount } from "../thread-bulk-actions.svelte.ts";

  const actions = useThreadActions();
  const thread = $derived(actions.snoozing?.thread);

  // Several selected threads: one deadline for all of them (ThreadBulkActions.openSnooze).
  const group = $derived(actions.snoozing?.group);
  let custom = $state(false);
  let dateTime = $state("");
  let saving = $state(false);
  let failure = $state<string>();
  let origin: HTMLElement | undefined;
  let options = $state<HTMLDivElement>();
  const min = $derived(custom ? localValue(new Date(clock.now + 60_000)) : undefined);

  const description = $derived(
    !group && thread?.snoozed
      ? thread.snoozedUntil
        ? `Wakes ${formatDateTime(thread.snoozedUntil)}.`
        : "Snoozed until you wake it."
      : "",
  );

  $effect(() => {
    if (thread) {
      origin = actions.returnFocus;

      if (actions.snoozing?.custom) chooseDate(true);
      else custom = false;
      dateTime = !group && thread.snoozedUntil ? localValue(timestampDate(thread.snoozedUntil)) : "";
      failure = undefined;
    } else if (origin) {
      const source = origin;
      origin = undefined;
      void tick().then(() => restoreSnoozeFocus(source));
    }
  });

  async function snooze(until?: Date) {
    if (!thread || saving) return;
    saving = true;
    failure = undefined;

    try {
      if (group) await actions.bulk.snoozeEach(group.threads, until);
      else await actions.setSnooze(thread.id, true, until);
      actions.snoozing = undefined;
      group?.done?.();
    } catch {
      failure = "Could not snooze the thread. Try again.";
    } finally {
      saving = false;
    }
  }

  function chooseDate(next: boolean) {
    custom = next;
    failure = undefined;
    const selector = next ? 'button[aria-haspopup="dialog"]' : "[data-snooze-custom]";
    void tick().then(() => options?.querySelector<HTMLElement>(selector)?.focus());
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const deadline = parseDateTime(dateTime);

    if (deadline && deadline.getTime() > Date.now()) void snooze(deadline);
    else failure = "Choose a date and time in the future.";
  }
</script>

<Dialog
  title={group ? `Snooze ${threadCount(group.threads.length)}` : thread?.snoozed ? "Change snooze" : "Snooze thread"}
  {description}
  dismissible={!saving}
  bind:open={
    () => Boolean(thread),
    (open) => {
      if (!open && !saving) actions.snoozing = undefined;
    }
  }
>
  <div class="grid gap-3" bind:this={options}>
    {#if custom}
      <form class="grid gap-4" onsubmit={submit}>
        <Field label="Wake at">
          <Input
            type="datetime-local"
            name="snoozedUntil"
            bind:value={dateTime}
            {min}
            required
            disabled={saving}
            placeholder="Choose date and time…"
          />
        </Field>
        <FieldError message={failure} />
        <div class="flex justify-end gap-2">
          {#if actions.snoozing?.custom}
            <Button disabled={saving} onclick={() => (actions.snoozing = undefined)}>Cancel</Button>
          {:else}
            <Button disabled={saving} onclick={() => chooseDate(false)}>Back</Button>
          {/if}
          <Button type="submit" variant="primary" loading={saving} disabled={!dateTime}>Snooze</Button>
        </div>
      </form>
    {:else}
      <div class="grid gap-1">
        {#each snoozePresets as preset, index (preset.value)}
          <Button
            data-autofocus={index === 0 ? "" : undefined}
            variant="ghost"
            disabled={saving}
            onclick={() => void snooze(snoozeDeadline(preset.value))}
            ><span class="flex-1 text-left">{preset.label}</span></Button
          >
        {/each}
        <Button variant="ghost" data-snooze-custom disabled={saving} onclick={() => chooseDate(true)}
          ><span class="flex-1 text-left">Choose date and time…</span></Button
        >
      </div>
      <FieldError message={failure} />
    {/if}
  </div>
</Dialog>
