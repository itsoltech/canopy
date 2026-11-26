<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { bindingEnabled } from "@canopy/ui/keybindings";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { useCommands } from "#lib/features/commands/registry.ts";
  import {
    bindingCatalogue,
    type BindingDefinition,
    type BindingGroup,
  } from "#lib/features/commands/binding-catalogue.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import BindingEditor from "#lib/features/commands/BindingEditor.svelte";
  import KeybindingRow from "#lib/features/commands/KeybindingRow.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import WindowedList from "#lib/shared/ui/WindowedList.svelte";

  const settings = useSettings();
  const registry = useCommands();
  const definitions = $derived(registry?.definitions() ?? [...bindingCatalogue]);
  let query = $state("");
  let error = $state("");
  let editing = $state<{ command: BindingDefinition; index?: number }>();
  const groups: BindingGroup[] = ["Navigation", "Threads", "Composer", "Messages", "Models", "Appearance", "Settings"];

  const filtered = $derived(
    definitions.filter(
      (d) =>
        bindingEnabled(d, settings.enabledModules) &&
        `${d.title} ${d.group} ${d.when} ${keybindings.get(d.id, d.defaults).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
    ),
  );

  type Entry =
    | { kind: "group"; key: string; group: BindingGroup; first: boolean }
    | { kind: "command"; key: string; command: BindingDefinition; first: boolean; last: boolean };

  // Group titles and their rows in one flat list, so only the rows near the viewport render.
  const entries = $derived.by(() => {
    const list: Entry[] = [];

    for (const group of groups) {
      const commands = filtered.filter((d) => d.group === group);

      if (!commands.length) continue;
      list.push({ kind: "group", key: `group:${group}`, group, first: list.length === 0 });

      for (const [index, command] of commands.entries()) {
        list.push({
          kind: "command",
          key: command.id,
          command,
          first: index === 0,
          last: index === commands.length - 1,
        });
      }
    }

    return list;
  });

  // Estimates before a row is measured: the one-line row and the group title with the gap above it.
  const estimate = (group: string) => (group === "group" ? 48 : 45);

  function remove(command: BindingDefinition, index: number) {
    error =
      keybindings.save(
        command.id,
        keybindings.get(command.id, command.defaults).filter((_, i) => i !== index),
        definitions,
      ) ?? "";
  }

  function resetCommand(command: BindingDefinition) {
    const conflict = command.defaults.flatMap((binding) => keybindings.conflicts(command.id, binding, definitions));

    if (conflict.length) {
      error = `The default shortcut is used by ${conflict.map((c) => c.title).join(", ")}. Remove that binding first.`;

      return;
    }

    keybindings.reset(command.id);
    error = "";
  }
</script>

<svelte:head><title>Keybindings · Settings · {applicationName}</title></svelte:head>
<div class="settings-stack">
  <p class="max-w-xl text-sm/5 text-zinc-500">This device · Shortcuts apply to this browser or desktop app.</p>
  <div class="flex items-stretch gap-2">
    <SearchField
      class="min-h-(--settings-control-height) flex-1 bg-surface"
      label="Search keybindings"
      placeholder="Search shortcuts"
      bind:value={query}
    />
    <Button
      icon="arrow-path"
      onclick={() => {
        keybindings.reset();
        error = "";
      }}>Restore device defaults</Button
    >
  </div>
  {#if error}<GrowIn><Alert tone="error">{error}</Alert></GrowIn>{/if}
  {#if entries.length}
    <WindowedList items={entries} key={(entry) => entry.key} group={(entry) => entry.kind} {estimate}>
      {#snippet row(entry)}
        {#if entry.kind === "group"}
          <h2 class={["px-1 pb-2 text-base/7 font-semibold text-zinc-950 dark:text-white", !entry.first && "pt-5"]}>
            {entry.group}
          </h2>
        {:else}
          {@const command = entry.command}
          <KeybindingRow
            {command}
            bindings={keybindings.get(command.id, command.defaults)}
            changed={Object.hasOwn(keybindings.overrides, command.id)}
            first={entry.first}
            last={entry.last}
            onedit={(index) => (editing = { command, index })}
            onremove={(index) => remove(command, index)}
            onreset={() => resetCommand(command)}
          />
        {/if}
      {/snippet}
    </WindowedList>
  {:else}<p class="py-8 text-center text-sm text-zinc-500" role="status">No commands match “{query}”.</p>{/if}
</div>
{#if editing}<BindingEditor
    command={editing.command}
    index={editing.index}
    {definitions}
    onclose={() => (editing = undefined)}
  />{/if}
