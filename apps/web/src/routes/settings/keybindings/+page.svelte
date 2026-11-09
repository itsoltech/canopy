<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { useCommands } from "#lib/features/commands/registry.ts";
  import {
    bindingCatalogue,
    type BindingDefinition,
    type BindingGroup,
  } from "#lib/features/commands/binding-catalogue.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import BindingEditor from "#lib/features/commands/BindingEditor.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  const registry = useCommands();
  const definitions = $derived(registry?.definitions() ?? [...bindingCatalogue]);
  let query = $state("");
  let error = $state("");
  let editing = $state<{ command: BindingDefinition; index?: number }>();
  const groups: BindingGroup[] = ["Navigation", "Threads", "Composer", "Messages", "Models", "Appearance", "Settings"];

  const filtered = $derived(
    definitions.filter((d) =>
      `${d.title} ${d.group} ${d.when} ${keybindings.get(d.id, d.defaults).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
    ),
  );

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
  <div class="flex flex-wrap items-start justify-between gap-3">
    <p class="max-w-xl text-sm/5 text-zinc-500">This device · Shortcuts apply to this browser or desktop app.</p>
    <Button
      size="sm"
      icon="arrow-path"
      onclick={() => {
        keybindings.reset();
        error = "";
      }}>Restore device defaults</Button
    >
  </div>
  <Input type="search" aria-label="Search keybindings" placeholder="Toggle sidebar, Mod+B" bind:value={query} />
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#each groups as group (group)}
    {@const entries = filtered.filter((d) => d.group === group)}
    {#if entries.length}<SettingsGroup title={group}>
        <div class="divide-y divide-zinc-950/5 dark:divide-white/10">
          {#each entries as command (command.id)}
            {@const bindings = keybindings.get(command.id, command.defaults)}
            <div
              class="flex flex-col items-start gap-3 px-(--settings-row-x) py-(--settings-row-y) sm:flex-row sm:items-center"
            >
              <div class="min-w-0 flex-1">
                <p class="text-sm/6 font-medium wrap-anywhere">{command.title}</p>
                <p class="text-sm/5 text-zinc-500">When: {command.when}.</p>
              </div>
              <ResettableControl changed={Object.hasOwn(keybindings.overrides, command.id)}>
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  {#each bindings as binding, index (binding)}
                    <div class="flex items-center gap-1">
                      <Button
                        size="sm"
                        aria-label={`Edit ${command.title}: ${binding}`}
                        onclick={() => (editing = { command, index })}><Kbd hotkey={binding} /></Button
                      ><IconButton
                        size="sm"
                        icon="x-mark"
                        label={`Remove ${command.title}: ${binding}`}
                        onclick={() => remove(command, index)}
                      />
                    </div>
                  {:else}<span class="text-sm text-zinc-500">Unassigned</span>{/each}
                  <IconButton
                    size="sm"
                    icon="plus"
                    label={`Add binding for ${command.title}`}
                    disabled={bindings.length >= 5}
                    onclick={() => (editing = { command })}
                  />
                </div>
                {#snippet reset()}<IconButton
                    size="sm"
                    icon="arrow-path"
                    label={`Reset ${command.title} to default`}
                    onclick={() => resetCommand(command)}
                  />{/snippet}
              </ResettableControl>
            </div>
          {/each}
        </div>
      </SettingsGroup>{/if}
  {/each}
  {#if !filtered.length}<p class="py-8 text-center text-sm text-zinc-500" role="status">
      No commands match “{query}”.
    </p>{/if}
</div>
{#if editing}<BindingEditor
    command={editing.command}
    index={editing.index}
    {definitions}
    onclose={() => (editing = undefined)}
  />{/if}
