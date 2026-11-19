<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { bots, ui } from "@canopy/contracts";
  import { safeFailureDetail } from "@canopy/domain";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { botList } from "../bot-list.svelte.ts";
  import { useBotHome } from "../home.svelte.ts";
  import { botWizardInstances } from "../live.ts";
  import { archiveBot } from "./lifecycle.ts";
  import { nodeRef, splitId } from "@canopy/domain/computers";

  const catalogs = useModelCatalog();
  const settings = useSettings();
  let id = $state("");
  let open = $state(false);
  let loading = $state(false);
  let loadError = $state("");
  let providers = $state.raw<ui.ProviderInstance[]>([]);
  let deleting = $state(false);
  let deleteTarget = $state.raw<bots.Bot>();
  let deletingBusy = $state(false);
  let deleteError = $state<string>();
  let generation = 0;
  let SettingsDialog = $state.raw<typeof import("./BotSettingsDialog.svelte").default>();
  const bot = $derived(botList.list.find((b) => b.id === id));
  const deleteName = $derived(deleteTarget?.configuration?.name);
  const deleteHome = useBotHome(() => deleteTarget?.nodeId);

  const instances = $derived(
    botWizardInstances(
      providers,
      [...catalogs.workers.values()].filter(
        (w) => splitId(w.workerId).node === (bot?.nodeId ? nodeRef(bot.nodeId) : undefined),
      ),
    ),
  );

  $effect(() => {
    async function edit(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const nextId = String(event.detail);
      const version = ++generation;
      id = nextId;
      loadError = "";
      loading = true;

      try {
        const [instancesJson, component] = await Promise.all([
          requestJson("GET", `/api/bots/${nextId}/providers`),
          import("./BotSettingsDialog.svelte"),
        ]);

        if (generation !== version) return;
        SettingsDialog = component.default;
        providers = decode(ui.ListProviderInstancesResponseSchema, instancesJson).instances;
        open = true;
      } catch (cause) {
        if (generation === version) loadError = cause instanceof Error ? cause.message : "Could not load bot settings.";
      } finally {
        if (generation === version) loading = false;
      }
    }

    const confirm = (event: Event) => {
      if (event instanceof CustomEvent) confirmRemoval(event.detail);
    };

    window.addEventListener("edit-bot", edit);
    window.addEventListener("delete-bot", confirm);

    return () => {
      window.removeEventListener("edit-bot", edit);
      window.removeEventListener("delete-bot", confirm);
      generation++;
    };
  });

  async function archive() {
    if (!bot) return;
    await archiveBot(bot, !bot.archived);
    // The gateway removes pins atomically; refresh the local settings with its version.
    await settings.pinBot(bot.id, false);
  }

  function confirmRemoval(target: bots.Bot) {
    if (deletingBusy) return;
    deleteTarget = target;
    deleteError = undefined;
    deleting = true;
  }

  async function remove() {
    const target = deleteTarget;

    if (!target || deletingBusy || deleteHome.reason) return;
    deletingBusy = true;
    deleteError = undefined;

    try {
      await requestJson("DELETE", `/api/bots/${target.id}`);
    } catch (cause) {
      deleteError = cause instanceof Error ? safeFailureDetail(cause.message) : "";

      return;
    } finally {
      deletingBusy = false;
    }

    if (id === target.id) open = false;
    deleting = false;
    window.dispatchEvent(new Event("bots-changed"));

    if (page.params.botId === target.id) await goto("/bots", { replace: true });
  }
</script>

{#if bot}
  {#if SettingsDialog}
    <SettingsDialog bind:open {bot} {providers} {instances} onarchive={archive} ondelete={() => confirmRemoval(bot)} />
  {/if}
{/if}
{#if deleteTarget}
  <Dialog
    bind:open={deleting}
    title="Delete bot?"
    description={`This removes ${deleteName ? `“${deleteName}”` : "the bot"} and its conversation from Canopy. Running turns stop. Canopy cancels queued turns, routines and reminders. You can’t undo this.`}
    dismissible={!deletingBusy}
  >
    <div class="grid gap-4">
      {#if deleteHome.reason}<Alert tone="warning">{deleteHome.reason} Try again when the computer is available.</Alert>
      {:else if deleteError !== undefined}
        <Alert tone="error">
          Could not delete this bot. Try again.
          {#if deleteError}
            <Disclosure class="mt-2">
              {#snippet summary()}Show details{/snippet}
              <div class="flex min-w-0 items-start gap-2">
                <pre class="min-w-0 flex-1 font-mono wrap-anywhere whitespace-pre-wrap select-text">{deleteError}</pre>
                <CopyButton text={deleteError} label="Copy error details" />
              </div>
            </Disclosure>
          {/if}
        </Alert>
      {/if}
      <DialogActions>
        <Button data-autofocus disabled={deletingBusy} onclick={() => (deleting = false)}>Cancel</Button>
        <Button variant="danger" disabled={Boolean(deleteHome.reason)} loading={deletingBusy} onclick={remove}
          >Delete bot</Button
        >
      </DialogActions>
    </div>
  </Dialog>
{/if}
<Dialog
  open={loading || Boolean(loadError)}
  title="Bot settings"
  description={loading ? "Loading your provider instances and connections…" : undefined}
>
  {#if loadError}<Alert tone="error">{loadError}</Alert><DialogActions
      ><Button onclick={() => (loadError = "")}>Close</Button></DialogActions
    >{/if}
</Dialog>
