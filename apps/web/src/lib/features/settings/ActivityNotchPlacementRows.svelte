<script lang="ts">
  import { onMount } from "svelte";
  import {
    defaultActivityNotchPlacement,
    type ActivityNotchDisplay,
    type ActivityNotchEdge,
    type ActivityNotchPlacement,
  } from "@canopy/ui/desktop";
  import Select from "#lib/shared/ui/Select.svelte";
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
  import OptionTile from "#lib/shared/ui/OptionTile.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import PreferenceRow from "./PreferenceRow.svelte";
  import ActivityNotchEdgePicker from "./ActivityNotchEdgePicker.svelte";

  type Mode = ActivityNotchPlacement["mode"];

  let placement = $state<ActivityNotchPlacement>();
  let displays = $state<ActivityNotchDisplay[]>([]);

  /** The notch is always on the main display, so switching back to an edge or a pill restores the chosen one. */
  let lastDisplay = $state<number>();
  let error = $state("");
  const fallback = defaultActivityNotchPlacement(window.canopyDesktop?.platform ?? "");

  const modes = [
    { mode: "notch", label: "Notch", detail: "top center" },
    { mode: "edge", label: "Edge", detail: "docked to a screen edge" },
    { mode: "floating", label: "Floating", detail: "anywhere" },
  ] as const satisfies readonly { mode: Mode; label: string; detail: string }[];

  const descriptions: Record<Mode, string> = {
    notch: "The overlay stays at the top center of your main display.",
    edge: "Drag the overlay along any screen edge to move it.",
    floating: "Drag the overlay anywhere on your displays to move it.",
  };

  const docked = $derived(placement?.mode === "edge" ? placement : undefined);
  const display = $derived(placement && placement.mode !== "notch" ? placement.display : lastDisplay);
  const connected = $derived(display === undefined || displays.some(({ id }) => id === display));

  const displayOptions = $derived<SelectOption[]>([
    { value: "main", label: "Main display", description: "Follows the main display in your system settings." },
    ...displays.map((screen, index) => ({
      value: String(screen.id),
      label: screen.label || `Display ${index + 1}`,
      description: `${screen.width} × ${screen.height}${screen.main ? ", main display" : ""}`,
    })),
    ...(connected
      ? []
      : [
          {
            value: "missing",
            label: "Disconnected display",
            description: "The overlay uses the main display until this one is back.",
          },
        ]),
  ]);

  const changed = $derived(placement !== undefined && JSON.stringify(placement) !== JSON.stringify(fallback));

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge?.activityNotchPlacement) return;
    const offPlacement = bridge.onActivityNotchPlacement?.(receive);
    const offDisplays = bridge.onActivityNotchDisplays?.((next) => (displays = next));
    void bridge
      .activityNotchPlacement()
      .then(receive)
      .catch(() => (error = "Could not load the overlay position. Restart Canopy to retry."));
    void bridge
      .activityNotchDisplays?.()
      .then((next) => (displays = next))
      .catch(() => (displays = []));

    return () => {
      offPlacement?.();
      offDisplays?.();
    };
  });

  function receive(next: ActivityNotchPlacement) {
    placement = next;

    if (next.mode !== "notch") lastDisplay = next.display;
  }

  async function save(next: ActivityNotchPlacement) {
    const previous = placement;
    placement = next;
    error = "";

    try {
      receive(await window.canopyDesktop!.setActivityNotchPlacement!(next));
    } catch {
      placement = previous;
      error = "Could not save the overlay position. Try again.";
    }
  }

  /** IPC keeps a key set to undefined, and main accepts a display only as a number, so an unset one is left out. */
  function onDisplay<T extends Exclude<ActivityNotchPlacement, { mode: "notch" }>>(next: T): T {
    return display === undefined ? next : { ...next, display };
  }

  function choose(mode: Mode) {
    if (mode === placement?.mode) return;

    if (mode === "notch") void save({ mode });
    else if (mode === "edge")
      void save(onDisplay(fallback.mode === "edge" ? fallback : { mode, edge: "right", offset: 0.25 }));
    else void save(onDisplay({ mode, x: 0.5, y: 0.15 }));
  }

  function pick(edge: ActivityNotchEdge, offset: number) {
    void save(onDisplay({ mode: "edge", edge, offset }));
  }

  function chooseDisplay(value: string) {
    if (!placement || placement.mode === "notch" || value === "missing") return;
    const { display: _, ...rest } = placement;

    void save(value === "main" ? rest : { ...rest, display: Number(value) });
  }

  export async function resetDefaults(): Promise<void> {
    if (changed) await save(fallback);
  }
</script>

{#snippet preview(mode: Mode)}
  <span class="relative block h-11 overflow-hidden rounded-md bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
    {#if mode === "notch"}
      <span class="absolute top-0 left-1/2 h-1.5 w-7 -translate-x-1/2 rounded-b-sm bg-zinc-950 dark:bg-zinc-100"></span>
    {:else if mode === "edge"}
      <span class="absolute right-0 bottom-2 h-4 w-1.5 rounded-l-sm bg-zinc-950 dark:bg-zinc-100"></span>
    {:else}
      <span class="absolute right-4 bottom-3 h-2 w-6 rounded-full bg-zinc-950 shadow-sm dark:bg-zinc-100"></span>
    {/if}
  </span>
{/snippet}

{#if placement}
  <PreferenceRow
    title="Position"
    description={descriptions[placement.mode]}
    {changed}
    onreset={() => save(fallback)}
    resetLabel="Reset the overlay position"
  >
    <div role="radiogroup" aria-label="Position" class="mt-3 grid max-w-80 grid-cols-3 gap-2">
      {#each modes as option (option.mode)}
        <OptionTile
          checked={placement?.mode === option.mode}
          label={`${option.label}, ${option.detail}`}
          onchange={() => choose(option.mode)}
          class="grid gap-1 p-1.5"
        >
          {@render preview(option.mode)}
          <span class="px-0.5 font-medium">{option.label}</span>
        </OptionTile>
      {/each}
    </div>
    <!-- The tiles sit under the description, so a narrow window never squeezes it. -->
    {#snippet control()}{/snippet}
  </PreferenceRow>
  {#if placement.mode !== "notch" && displays.length > 1}
    <SettingsRow title="Display" description="The display the overlay sits on until you drag it to another one.">
      {#snippet control()}<div class="w-56 max-w-full">
          <Select
            aria-label="Display"
            options={displayOptions}
            value={display === undefined ? "main" : connected ? String(display) : "missing"}
            onchange={chooseDisplay}
          />
        </div>{/snippet}
    </SettingsRow>
  {/if}
  {#if docked}
    <SettingsRow title="Edge" description="The spot on the screen edge where the tab docks.">
      {#snippet control()}
        <ActivityNotchEdgePicker edge={docked.edge} offset={docked.offset} onpick={pick} />
      {/snippet}
    </SettingsRow>
  {/if}
{/if}
{#if error}<Alert tone="error">{error}</Alert>{/if}
