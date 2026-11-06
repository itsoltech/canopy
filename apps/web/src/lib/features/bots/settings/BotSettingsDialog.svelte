<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { bots, ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ModelOption } from "#lib/features/models/catalog.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { botList } from "../bot-list.svelte.ts";
  import {
    appearanceError,
    selectionError,
    type BotAppearanceDraft,
    type BotProviderInstance,
  } from "../wizard/draft.ts";
  import { mascotShapes, normalizeColor } from "../mascot.ts";
  import EditBotAppearance from "../wizard/EditBotAppearance.svelte";
  import ProviderModelFields from "../wizard/ProviderModelFields.svelte";
  import BotWorkerField from "../wizard/BotWorkerField.svelte";
  import { botInstancesOnWorker } from "../live.ts";
  import BotConnections from "./BotConnections.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import BotHome from "../components/BotHome.svelte";
  import { useBotHome } from "../home.svelte.ts";
  import { BOT_APPROVAL_OPTIONS, BOT_THREAD_PERMISSION_OPTIONS } from "@canopy/domain/bot-chat";
  import BotApprovalRules from "./BotApprovalRules.svelte";

  let {
    open = $bindable(false),
    bot,
    providers,
    instances,
    onarchive,
    ondelete,
    class: className,
  }: {
    open?: boolean;
    bot: bots.Bot;
    providers: readonly ui.ProviderInstance[];
    instances: readonly BotProviderInstance[];
    onarchive: () => Promise<void>;
    ondelete: () => void;
    class?: ClassValue;
  } = $props();

  let appearance = $state<BotAppearanceDraft>({ name: "", shape: "round", color: "#f97316" });
  let originalName = $state("");
  let instructions = $state("");
  let instanceId = $state("");
  let workerId = $state("");
  const workerInstances = $derived(botInstancesOnWorker(instances, workerId));
  let option = $state.raw<ModelOption>();
  let effort = $state<string>();
  let modelChanged = $state(false);
  let policy = $state("safe");
  let threadPermission = $state("same_bot");
  let busy = $state(false);
  let error = $state("");
  let wasOpen = false;
  let session = $state(0);
  const existingNames = $derived(botList.list.map((b) => b.configuration?.name ?? ""));
  const home = useBotHome(() => bot.nodeId);

  $effect(() => {
    if (open && !wasOpen)
      untrack(() => {
        const c = bot.configuration!;
        appearance = { name: c.name, shape: mascotShapes.find((s) => s.id === c.shape)?.id ?? "round", color: c.color };
        originalName = c.name;
        instructions = c.instructions;
        instanceId = instanceKeyOf({ harness: c.provider, id: c.providerInstance });
        workerId = c.workerId;
        modelChanged = false;
        option = instances.find((i) => i.id === instanceId)?.models.find((m) => m.model === c.model);
        effort = c.effort || undefined;
        policy = c.approvalPolicy || "safe";
        threadPermission = c.threadPermission || "same_bot";
        error = "";
        session++;
      });
    wasOpen = open;
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();

    if (busy || home.reason) return;
    error = appearanceError(appearance, existingNames, originalName) ?? "";

    if (error) return;

    // An unavailable existing model need not prevent an appearance/instructions edit.
    if (modelChanged) error = selectionError(workerInstances, instanceId, option, effort) ?? "";

    if (error) return;
    const provider = providers.find((p) => instanceKeyOf(p) === instanceId);

    const configuration = create(bots.BotConfigurationSchema, {
      ...bot.configuration!,
      ...appearance,
      color: normalizeColor(appearance.color)!,
      instructions,
      workerId,
      approvalPolicy: policy,
      threadPermission,
      ...(modelChanged &&
        provider &&
        option && {
          provider: provider.harness,
          providerInstance: provider.id,
          model: option.model,
          effort: effort ?? "",
        }),
    });

    busy = true;

    try {
      await botList.save(bot, configuration);
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not save bot settings.";
    } finally {
      busy = false;
    }
  }

  async function archive() {
    if (home.reason) return;
    busy = true;

    try {
      await onarchive();
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not archive this bot.";
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="Bot settings" size="lg" bare dismissible={!busy} class={className}>
  <form onsubmit={save} aria-busy={busy || undefined}>
    <div class="flex items-start justify-between gap-4 px-5 pt-6 pb-5 sm:px-6">
      <div class="grid min-w-0 gap-1">
        <h2 class="text-xl font-semibold text-balance">Bot settings</h2>
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          {bot.createdByBotName ? `Created by ${bot.createdByBotName}` : "A familiar face, your way."}
        </p>
      </div>
      <IconButton icon="x-mark" label="Close settings" size="sm" disabled={busy} onclick={() => (open = false)} />
    </div>
    <div class="px-5 sm:px-6">
      <BotHome nodeId={bot.nodeId} banner />
      {#key session}
        <SettingsSection title="Appearance"
          ><EditBotAppearance
            inline
            bind:value={appearance}
            {existingNames}
            {originalName}
            disabled={busy}
          /></SettingsSection
        >
        <SettingsSection
          title="Instructions"
          description="Give your bot a role, context, or preferences to remember. Changes apply from its next turn."
        >
          <Field label="Standing instructions" optional
            ><Textarea
              bind:value={instructions}
              rows={6}
              maxlength={32000}
              disabled={busy}
              placeholder="Be concise. Ask before making assumptions. Always answer in English."
            /></Field
          >
        </SettingsSection>
        <SettingsSection title="Model" description="Choose a provider instance and model available on your worker.">
          <ProviderModelFields
            instances={workerInstances}
            bind:instanceId
            bind:option
            bind:effort
            disabled={busy}
            onchange={() => (modelChanged = true)}
          />
          <BotWorkerField bind:value={workerId} {instanceId} homeNodeId={bot.nodeId} disabled={busy || !!home.reason} />
        </SettingsSection>
        <SettingsSection
          title="Permissions"
          description="Protected actions and changes to the bot’s model or permissions always ask first."
        >
          <Field label="Ask for approval"
            ><Select bind:value={policy} disabled={busy} options={BOT_APPROVAL_OPTIONS} /></Field
          >
          <BotApprovalRules botId={bot.id} disabled={busy || !!home.reason} />
          <Field label="Threads started by this bot">
            <Select bind:value={threadPermission} disabled={busy} options={BOT_THREAD_PERMISSION_OPTIONS} />
          </Field>
          <p class="text-sm text-zinc-500 dark:text-zinc-400">Thread tool requests also appear in this bot’s chat.</p>
        </SettingsSection>
        <SettingsSection
          title="Connections"
          description="Connector accounts granted to this bot. Available tools follow the approval policy above."
        >
          {#if bot.nodeId}<p class="text-zinc-500 dark:text-zinc-400">
              Connections belong to {home.name}. Manage account authorization on that computer.
            </p>{:else}<BotConnections botId={bot.id} />{/if}
        </SettingsSection>
        <SettingsSection
          title="Danger zone"
          description="Archive to keep the conversation and settings. Delete removes this bot and its conversation from Canopy."
        >
          <div class="flex flex-wrap gap-2">
            <Button disabled={busy || Boolean(home.reason)} onclick={archive}
              >{bot.archived ? "Unarchive bot" : "Archive bot"}</Button
            >
            <Button variant="danger" disabled={busy || Boolean(home.reason)} onclick={ondelete}>Delete bot…</Button>
          </div>
        </SettingsSection>
      {/key}
      {#if error}<div class="pb-4"><Alert tone="error">{error}</Alert></div>{/if}
    </div>
    <div
      class="sticky bottom-0 flex items-center justify-end gap-2 border-t border-zinc-950/10 bg-white px-5 pt-3 pb-[max(--spacing(4),env(safe-area-inset-bottom))] sm:px-6 dark:border-white/10 dark:bg-zinc-950"
    >
      <div class="mr-auto text-sm text-zinc-500 dark:text-zinc-400" role="status">{busy ? "Saving…" : ""}</div>
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" disabled={Boolean(home.reason)} loading={busy}>Save changes</Button>
    </div>
  </form>
</Dialog>
