<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue, HTMLInputAttributes } from "svelte/elements";
  import { controlClasses, useField } from "./field.ts";
  import {
    dateTimeError,
    formatDateTime,
    localValue,
    parseDay,
    shiftDay,
    stepTime,
    userTimeZone,
    type DateTimeKind,
  } from "./date-time.ts";
  import Button from "./Button.svelte";
  import Calendar from "./Calendar.svelte";
  import PickerTrigger from "./PickerTrigger.svelte";
  import Popover from "./Popover.svelte";
  import StepperButtons from "./StepperButtons.svelte";

  /** Internal renderer for Input's date/time types. Same local ISO wire values; locale display. */
  type Props = Omit<HTMLInputAttributes, "class" | "type"> & { type: DateTimeKind; class?: ClassValue };

  let {
    value = $bindable(),
    type,
    min,
    max,
    id: explicitId,
    name,
    form,
    disabled,
    readonly,
    required,
    placeholder,
    class: className,
    onchange,
    oninput,
    onkeydown,
    ...rest
  }: Props = $props();

  const field = useField();
  const uid = $props.id();
  const id = $derived(explicitId ?? field?.id ?? `${uid}-trigger`);
  const zone = userTimeZone();
  const lower = $derived(min == null ? undefined : String(min));
  const upper = $derived(max == null ? undefined : String(max));
  const wire = $derived(value == null ? "" : String(value));
  const formatted = $derived(formatDateTime(wire, type, undefined, zone));
  let open = $state(false);
  let day = $state("");
  let time = $state("09:00");
  let button = $state<HTMLButtonElement>();
  let hidden = $state<HTMLInputElement>();
  let validation = $state<HTMLInputElement>();
  const label = $derived(rest["aria-label"] ?? button?.labels?.[0]?.textContent?.trim() ?? name ?? "Date and time");
  const draft = $derived(type === "time" ? time : type === "date" ? day : `${day}T${time}`);
  const error = $derived(dateTimeError(draft, type, lower, upper, zone));
  const valueError = $derived(wire ? dateTimeError(wire, type, lower, upper, zone) : undefined);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      let initial = wire || localValue(new Date(), type, zone);

      if (lower && initial < lower) initial = lower;

      if (upper && initial > upper) initial = upper;
      day = type === "time" ? localValue(new Date(), "date", zone) : initial.slice(0, 10);

      if (!parseDay(day)) day = localValue(new Date(), "date", zone);
      time = type === "time" ? initial : initial.slice(11, 16) || "09:00";
    });
  });

  $effect(() => {
    if (disabled || readonly) open = false;
  });

  $effect(() => {
    validation?.setCustomValidity(valueError ?? "");
  });

  $effect(() => {
    const initial = untrack(() => value);
    const owner = button?.form;

    const reset = () => {
      value = initial;
      open = false;
    };

    owner?.addEventListener("reset", reset);

    return () => owner?.removeEventListener("reset", reset);
  });

  function apply() {
    if (error || disabled || readonly) return;
    commit(draft);
  }

  function commit(next: string) {
    value = next;

    if (hidden) hidden.value = next;
    hidden?.dispatchEvent(new Event("input", { bubbles: true }));
    hidden?.dispatchEvent(new Event("change", { bubbles: true }));
    open = false;
    button?.focus({ preventScroll: true });
  }

  function quick(kind: "hour" | "tomorrow") {
    const next =
      kind === "hour"
        ? localValue(new Date(Date.now() + 3_600_000), type, zone)
        : `${shiftDay(localValue(new Date(), "date", zone), 1)}${type === "date" ? "" : "T09:00"}`;

    day = next.slice(0, 10);
    time = next.slice(11, 16) || "09:00";
  }
</script>

<div class={className}>
  <input {...rest} bind:this={hidden} type="hidden" {name} {form} {disabled} value={wire} {onchange} {oninput} />
  <input
    bind:this={validation}
    type="text"
    class="sr-only"
    tabindex="-1"
    aria-hidden="true"
    value={wire}
    {required}
    {form}
    {disabled}
    oninvalid={(event) => {
      event.preventDefault();
      button?.focus();
    }}
  />
  <Popover
    bind:open
    label="Choose {label}"
    sheet
    maxHeight="min(var(--float-available-height,40rem),40rem)"
    class="w-96 max-w-[calc(100vw-1rem)]"
  >
    {#snippet trigger(props)}
      <PickerTrigger
        {...props}
        bind:element={button}
        {id}
        aria-haspopup="dialog"
        aria-readonly={readonly || undefined}
        {form}
        disabled={disabled || readonly}
        aria-label={rest["aria-label"]}
        aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
        aria-invalid={rest["aria-invalid"] || field?.invalid || Boolean(valueError) || undefined}
        aria-required={required || undefined}
        text={formatted || placeholder || (type === "time" ? "Choose time…" : "Choose date…")}
        icon={type === "time" ? "clock" : "calendar-days"}
      />
    {/snippet}
    <div class="grid gap-3 p-3">
      {#if type !== "time"}
        <Calendar value={day} min={lower?.slice(0, 10)} max={upper?.slice(0, 10)} onchange={(next) => (day = next)} />
        <div class="flex flex-wrap gap-2">
          {#if type === "datetime-local"}<Button size="sm" onclick={() => quick("hour")}>In 1 hour</Button>{/if}
          <Button size="sm" onclick={() => quick("tomorrow")}>{type === "date" ? "Tomorrow" : "Tomorrow 9:00"}</Button>
        </div>
      {/if}
      {#if type !== "date"}
        <div class="grid gap-1.5">
          <label for="{uid}-time" class="text-sm/6 font-medium">Time</label>
          <div class="flex items-center gap-3">
            <input
              id="{uid}-time"
              name="{name ?? uid}-time-draft"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="{uid}-time-hint"
              aria-invalid={error ? true : undefined}
              bind:value={time}
              class={[controlClasses, "min-w-0 flex-1 tabular-nums pointer-coarse:min-h-12"]}
              onkeydown={(event) => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  time = stepTime(time, event.key === "ArrowUp" ? 1 : -1);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  apply();
                }
              }}
            />
            <StepperButtons
              label="time by 15 minutes"
              decrease={() => (time = stepTime(time, -15))}
              increase={() => (time = stepTime(time, 15))}
            />
          </div>
          <p id="{uid}-time-hint" class="text-sm/5 text-zinc-500 dark:text-zinc-400">
            HH:MM · 24-hour time{type === "datetime-local" ? ` · ${zone}` : ""}
          </p>
        </div>
      {/if}
      {#if error}<p role="alert" class="text-sm/5 text-rose-600 dark:text-rose-400">{error}</p>{/if}
      <div class="flex justify-end gap-2 border-t border-zinc-950/5 pt-3 dark:border-white/10">
        {#if !required && wire}<Button size="sm" variant="ghost" onclick={() => commit("")}>Clear</Button>{/if}
        <Button size="sm" onclick={() => (open = false)}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={Boolean(error)} onclick={apply}>Apply</Button>
      </div>
    </div>
  </Popover>
</div>
