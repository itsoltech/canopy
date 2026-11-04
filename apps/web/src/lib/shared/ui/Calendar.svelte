<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { calendarDays, localValue, parseDay, shiftDay, shiftMonth } from "./date-time.ts";
  import IconButton from "./IconButton.svelte";
  import TouchTarget from "./TouchTarget.svelte";

  /** Calendar grid uses one tab stop; arrows, Home/End, PageUp/Down (Shift: year) move it. */
  let {
    value,
    min,
    max,
    onchange,
    class: className,
  }: {
    value: string;
    min?: string | undefined;
    max?: string | undefined;
    onchange: (day: string) => void;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  const today = localValue(new Date(), "date");
  let focused = $state(today);
  let month = $state(today);

  $effect(() => {
    focused = value || today;
    month = untrack(() => focused);
  });

  const weeks = $derived(calendarDays(month));

  const monthLabel = $derived(
    new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(parseDay(month)),
  );

  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, 7 + i)),
    ),
  );

  const unavailable = (day: string) => Boolean((min && day < min) || (max && day > max));

  const label = (day: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" }).format(parseDay(day));

  async function focusDay(day: string) {
    const bounded = min && day < min ? min : max && day > max ? max : day;
    focused = bounded;
    month = bounded;
    await tick();
    document.getElementById(`${id}-${bounded}`)?.focus({ preventScroll: true });
  }

  function navigate(event: KeyboardEvent, day: string) {
    let next: string;

    switch (event.key) {
      case "ArrowLeft":
        next = shiftDay(day, -1);
        break;
      case "ArrowRight":
        next = shiftDay(day, 1);
        break;
      case "ArrowUp":
        next = shiftDay(day, -7);
        break;
      case "ArrowDown":
        next = shiftDay(day, 7);
        break;
      case "Home":
        next = shiftDay(day, -parseDay(day)!.getUTCDay());
        break;
      case "End":
        next = shiftDay(day, 6 - parseDay(day)!.getUTCDay());
        break;
      case "PageUp":
        next = shiftMonth(day, event.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        next = shiftMonth(day, event.shiftKey ? 12 : 1);
        break;
      default:
        return;
    }

    event.preventDefault();
    void focusDay(next);
  }
</script>

<div class={className}>
  <div class="flex items-center justify-between gap-3 pb-2">
    <IconButton
      icon="chevron-right"
      iconClass="rotate-180"
      label="Previous month"
      disabled={Boolean(min && shiftMonth(`${month.slice(0, 7)}-01`, 0) <= `${min.slice(0, 7)}-01`)}
      onclick={() => void focusDay(shiftMonth(focused, -1))}
    />
    <h3 id="{id}-month" aria-live="polite" class="text-base/6 font-medium sm:text-sm/6">{monthLabel}</h3>
    <IconButton
      icon="chevron-right"
      label="Next month"
      disabled={Boolean(max && month.slice(0, 7) >= max.slice(0, 7))}
      onclick={() => void focusDay(shiftMonth(focused, 1))}
    />
  </div>
  <table
    role="grid"
    aria-labelledby="{id}-month"
    class="w-full table-fixed border-separate border-spacing-0 text-center text-sm/6 tabular-nums"
  >
    <thead
      ><tr
        >{#each weekdays as day, index (index)}<th scope="col" class="pb-1 font-normal text-zinc-500 dark:text-zinc-400"
            >{day}</th
          >{/each}</tr
      ></thead
    >
    <tbody>
      {#each weeks as week, index (index)}
        <tr
          >{#each week as day (day)}
            <td role="gridcell" aria-selected={day === value} class="p-0.5">
              <button
                id="{id}-{day}"
                type="button"
                aria-label={label(day)}
                aria-current={day === today ? "date" : undefined}
                data-autofocus={day === focused || undefined}
                tabindex={day === focused ? 0 : -1}
                disabled={unavailable(day)}
                class={[
                  "relative grid w-full place-items-center rounded-lg py-1.5 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-25 pointer-coarse:min-h-12",
                  day === value
                    ? "bg-brand-600 font-medium text-white dark:bg-brand-500"
                    : "hover:bg-zinc-950/5 dark:hover:bg-white/10",
                  day.slice(0, 7) !== month.slice(0, 7) && day !== value && "text-zinc-400 dark:text-zinc-500",
                  day === today && day !== value && "ring-1 ring-brand-500/60 ring-inset",
                ]}
                onkeydown={(event) => navigate(event, day)}
                onclick={() => {
                  focused = day;
                  month = day;
                  onchange(day);
                }}
              >
                {Number(day.slice(-2))}<TouchTarget />
              </button>
            </td>
          {/each}</tr
        >
      {/each}
    </tbody>
  </table>
  <p class="sr-only">
    Use arrow keys to move by day or week, Page Up and Page Down to change month, and Enter to choose.
  </p>
</div>
