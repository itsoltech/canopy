<script lang="ts">
  import { tick, untrack } from "svelte";
  import { isString } from "#lib/shared/json.ts";
  import type { ClassValue } from "svelte/elements";
  import type { ModelOption } from "#lib/features/models/catalog.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { focusables } from "#lib/shared/ui/floating.ts";
  import { defaultAppearance, normalizeColor, type MascotShapeId } from "../mascot.ts";
  import AppearanceFields from "./AppearanceFields.svelte";
  import ProviderModelFields from "./ProviderModelFields.svelte";
  import {
    appearanceError,
    selectionError,
    type BotAppearanceDraft,
    type BotProviderInstance,
    type CreateBotDraft,
  } from "./draft.ts";

  /** Internal shared dialog: public create/edit components keep their callback contracts separate. */
  let {
    open = $bindable(false),
    instances = [],
    existingNames,
    initial,
    oncreate,
    onsave,
    class: className,
  }: {
    open?: boolean;
    instances?: readonly BotProviderInstance[];
    existingNames: readonly string[];
    initial?: BotAppearanceDraft;
    oncreate?: (draft: CreateBotDraft) => Promise<void>;
    onsave?: (draft: BotAppearanceDraft) => Promise<void>;
    class?: ClassValue;
  } = $props();

  const editing = $derived(initial !== undefined);
  let name = $state("");
  let shape = $state<MascotShapeId>("round");
  let color = $state(defaultAppearance.color);
  let instanceId = $state("");
  let option = $state.raw<ModelOption>();
  let effort = $state<string>();
  let busy = $state(false);
  let submitted = $state(false);
  let error = $state<string>();
  let form = $state<HTMLFormElement>();
  let session = $state(0);
  let wasOpen = false;

  $effect(() => {
    if (open && !wasOpen)
      untrack(() => {
        name = initial?.name ?? "";
        shape = initial?.shape ?? defaultAppearance.shape;
        color = initial?.color ?? defaultAppearance.color;
        instanceId = "";
        option = undefined;
        effort = undefined;
        error = undefined;
        submitted = false;
        session += 1;
        // The session key remounts fields after Dialog's initial focus; focus the fresh input.
        void tick().then(() => {
          if (open) form?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
        });
      });
    wasOpen = open;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();

    if (busy) return;
    submitted = true;
    error = appearanceError({ name, shape, color }, existingNames, initial?.name);

    if (error) {
      await tick();
      form?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();

      return;
    }

    if (!editing) error = selectionError(instances, instanceId, option, effort);

    if (error) return;
    const appearance: BotAppearanceDraft = { name: name.trim().normalize("NFC"), shape, color: normalizeColor(color)! };
    busy = true;

    try {
      if (editing && onsave) await onsave(appearance);
      else if (oncreate && option)
        await oncreate({ ...appearance, providerInstanceId: instanceId, model: option.model, effort });
      else throw new Error("No save handler is configured.");
      open = false;
    } catch (cause) {
      error =
        (cause instanceof Error ? cause.message : isString(cause) ? cause : "") ||
        "Could not save your bot. Please try again.";
    } finally {
      busy = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.defaultPrevented) return;
    const target = event.target;

    if (!(target instanceof Element) || target.closest("[popover]")) return;

    if (event.key === "Tab" && form) {
      const controls = focusables(form).filter((el) => el.tabIndex >= 0);

      const first = controls[0],
        last = controls.at(-1);

      if (event.shiftKey && target === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && target === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    if (event.key === "Enter" && target.matches("input, [role=radio]")) {
      event.preventDefault();
      form?.requestSubmit();
    }
  }
</script>

<Dialog
  bind:open
  title={editing ? "Edit Bot appearance" : "Create New Bot"}
  bare
  dismissible={!busy}
  class={className}
  onkeydown={keydown}
>
  <form bind:this={form} novalidate onsubmit={submit} aria-busy={busy || undefined}>
    <div class="flex items-start justify-between gap-4 px-5 pt-6 pb-4 sm:px-6">
      <div class="grid gap-1">
        <p aria-hidden="true" class="text-xl font-semibold text-balance">
          {editing ? "Edit Bot appearance" : "Create New Bot"}
        </p>
        <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          {editing ? "A fresh look for a familiar face." : "A little character. A mind of its own."}
        </p>
      </div>
      <IconButton icon="x-mark" label="Close" size="sm" disabled={busy} onclick={() => (open = false)} />
    </div>
    <div class="grid gap-5 px-5 pb-5 sm:px-6">
      {#key session}
        <AppearanceFields
          bind:name
          bind:shape
          bind:color
          {existingNames}
          originalName={initial?.name}
          {submitted}
          disabled={busy}
        />
        {#if !editing}<ProviderModelFields {instances} bind:instanceId bind:option bind:effort disabled={busy} />{/if}
      {/key}
      {#if error}<Alert tone="error">{error}</Alert>{/if}
    </div>
    <div
      class="sticky bottom-0 flex items-center justify-end gap-2 border-t border-zinc-950/10 bg-white px-5 pt-3 pb-[max(--spacing(4),env(safe-area-inset-bottom))] sm:px-6 dark:border-white/10 dark:bg-zinc-950"
    >
      <div class="mr-auto text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">
        {busy ? (editing ? "Saving appearance…" : "Creating your bot…") : ""}
      </div>
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!editing && !option}
        >{editing ? "Save changes" : "Create Bot"}</Button
      >
    </div>
  </form>
</Dialog>
