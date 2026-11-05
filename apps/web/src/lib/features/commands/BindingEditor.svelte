<script lang="ts">
  import { untrack } from "svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { recordBinding } from "./binding-keys.ts";
  import { keybindings } from "./keybindings.svelte.ts";
  import type { BindingDefinition } from "./binding-catalogue.ts";

  let {
    command,
    index,
    definitions,
    onclose,
  }: {
    command: BindingDefinition;
    index?: number | undefined;
    definitions: readonly BindingDefinition[];
    onclose: () => void;
  } = $props();

  let open = $state(true);

  let value = $state(
    untrack(() => (index === undefined ? "" : (keybindings.get(command.id, command.defaults)[index] ?? ""))),
  );

  let recording = $state(false);
  let error = $state("");

  $effect(() => {
    if (!open) onclose();
  });

  $effect(() => {
    keybindings.recording = true;

    return () => {
      keybindings.recording = false;
    };
  });

  $effect(() => {
    if (!recording) return;

    const record = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.key === "Escape") {
        recording = false;

        return;
      }

      if (event.isComposing || event.repeat) return;
      const shortcut = recordBinding(event);

      if (shortcut) {
        value = shortcut;
        recording = false;
        error = "";
      }
    };

    window.addEventListener("keydown", record, true);

    return () => window.removeEventListener("keydown", record, true);
  });

  function save() {
    const bindings = [...keybindings.get(command.id, command.defaults)];

    if (index === undefined) bindings.push(value);
    else bindings[index] = value;
    error = keybindings.save(command.id, bindings, definitions) ?? "";

    if (!error) open = false;
  }
</script>

<Dialog bind:open title={`${index === undefined ? "Add" : "Edit"} shortcut`} description={`When: ${command.when}.`}>
  <form
    class="mt-4 grid gap-4"
    onsubmit={(event) => {
      event.preventDefault();
      save();
    }}
  >
    <p class="text-sm/6 font-medium wrap-anywhere">{command.title}</p>
    <Field label="Shortcut" description="Mod means Command on Mac and Control elsewhere.">
      <Input bind:value readonly={recording} data-autofocus placeholder="Mod+Shift+P" oninput={() => (error = "")} />
    </Field>
    <div class="flex flex-wrap items-center gap-2">
      <Button type="button" icon="command-line" onclick={() => (recording = !recording)}
        >{recording ? "Stop recording" : "Record shortcut"}</Button
      >
      {#if recording}<p class="text-sm text-zinc-500" role="status">
          Press the shortcut. Escape cancels recording.
        </p>{/if}
    </div>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <div class="flex justify-end gap-2">
      <Button type="button" onclick={() => (open = false)}>Cancel</Button><Button
        type="submit"
        variant="primary"
        disabled={!value.trim() || recording}>Save shortcut</Button
      >
    </div>
  </form>
</Dialog>
