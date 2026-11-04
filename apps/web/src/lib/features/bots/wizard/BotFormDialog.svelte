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
  import BotWorkerField from "./BotWorkerField.svelte";
  import { botInstancesOnWorker } from "../live.ts";
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
    loading = false,
    loadError = "",
    onreload,
    class: className,
  }: {
    open?: boolean;
    instances?: readonly BotProviderInstance[];
    existingNames: readonly string[];
    initial?: BotAppearanceDraft;
    oncreate?: (draft: CreateBotDraft) => Promise<void>;
    onsave?: (draft: BotAppearanceDraft) => Promise<void>;
    loading?: boolean;
    loadError?: string;
    onreload?: () => void;
    class?: ClassValue;
  } = $props();

  const editing = $derived(initial !== undefined);
  let name = $state("");
  let shape = $state<MascotShapeId>("round");
  let color = $state(defaultAppearance.color);
  let instanceId = $state("");
  let workerId = $state("");
  const workerInstances = $derived(botInstancesOnWorker(instances, workerId));
  let option = $state.raw<ModelOption>();
  let effort = $state<string>();
  let busy = $state(false);
  let submitted = $state(false);
  let appearanceOpen = $state(false);
  let error = $state<string>();
  let form = $state<HTMLFormElement>();
  let session = $state(0);
  let wasOpen = false;

  const status = $derived.by(() => {
    if (busy) return editing ? "Saving appearance…" : "Creating your bot…";

    if (editing) return "";

    if (loading) return "Loading models before you can create a bot.";

    if (loadError) return "Reload models to continue.";

    return option ? "" : "Choose an available model to create your bot.";
  });

  $effect(() => {
    if (open && !wasOpen)
      untrack(() => {
        name = initial?.name ?? "";
        shape = initial?.shape ?? defaultAppearance.shape;
        color = initial?.color ?? defaultAppearance.color;
        instanceId = "";
        workerId = "";
        option = undefined;
        effort = undefined;
        error = undefined;
        submitted = false;
        appearanceOpen = false;
        session += 1;
        // Focus the fresh readiness section on create, or the name input on appearance-only edit.
        void tick().then(() => {
          if (open) form?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
        });
      });
    wasOpen = open;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();

    if (busy || (!editing && (loading || loadError))) return;
    submitted = true;
    error = appearanceError({ name, shape, color }, existingNames, initial?.name);

    if (error) {
      if (!normalizeColor(color)) appearanceOpen = true;
      await tick();
      form?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();

      return;
    }

    if (!editing) error = selectionError(workerInstances, instanceId, option, effort);

    if (error) return;
    const appearance: BotAppearanceDraft = { name: name.trim().normalize("NFC"), shape, color: normalizeColor(color)! };
    busy = true;

    try {
      if (editing && onsave) await onsave(appearance);
      else if (oncreate && option)
        await oncreate({ ...appearance, providerInstanceId: instanceId, workerId, model: option.model, effort });
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
          {editing ? "A fresh look for a familiar face." : "Choose a model, then give your bot a name."}
        </p>
      </div>
      <IconButton icon="x-mark" label="Close" size="sm" disabled={busy} onclick={() => (open = false)} />
    </div>
    <div class="grid gap-5 px-5 pb-5 sm:px-6">
      {#key session}
        {#if !editing}
          <div tabindex="-1" data-autofocus class="grid min-w-0 gap-5 outline-none">
            {#if loading}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                Loading providers and models…
              </p>
            {:else if loadError}<Alert tone="error">{loadError}</Alert><Button onclick={onreload}>Try again</Button>
            {:else}<ProviderModelFields
                instances={workerInstances}
                bind:instanceId
                bind:option
                bind:effort
                disabled={busy}
              />{/if}
            <BotWorkerField bind:value={workerId} {instanceId} disabled={busy} />
          </div>
        {/if}
        <AppearanceFields
          bind:name
          bind:shape
          bind:color
          {existingNames}
          originalName={initial?.name}
          {submitted}
          collapsible={!editing}
          bind:expanded={appearanceOpen}
          disabled={busy}
        />
      {/key}
      {#if error}<Alert tone="error">{error}</Alert>{/if}
    </div>
    <div
      class="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-950/10 bg-white px-5 pt-3 pb-[max(--spacing(4),env(safe-area-inset-bottom))] sm:px-6 dark:border-white/10 dark:bg-zinc-950"
    >
      {#if status}<p
          class="mr-auto min-w-0 basis-full text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400"
          role="status"
        >
          {status}
        </p>{/if}
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!editing && (loading || !!loadError || !option)}
        >{editing ? "Save changes" : "Create Bot"}</Button
      >
    </div>
  </form>
</Dialog>
