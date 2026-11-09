<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { bots, ui } from "@canopy/contracts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import { botList } from "../bot-list.svelte.ts";
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
  let deletingBusy = $state(false);
  let deleteError = $state("");
  let generation = 0;
  let SettingsDialog = $state.raw<typeof import("./BotSettingsDialog.svelte").default>();
  const bot = $derived(botList.list.find((b) => b.id === id));

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

    const remove = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      id = String(event.detail);
      deleting = true;
      deleteError = "";
    };

    window.addEventListener("edit-bot", edit);
    window.addEventListener("delete-bot", remove);

    return () => {
      window.removeEventListener("edit-bot", edit);
      window.removeEventListener("delete-bot", remove);
      generation++;
    };
  });

  async function archive() {
    if (!bot) return;
    await archiveBot(bot, !bot.archived);
    // The gateway removes pins atomically; refresh the local settings with its version.
    await settings.pinBot(bot.id, false);
  }

  async function remove() {
    if (!bot || deletingBusy) return;
    deletingBusy = true;

    try {
      await requestJson("DELETE", `/api/bots/${bot.id}`);
      botList.list = botList.list.filter((b) => b.id !== id);
      open = false;
      deleting = false;
      window.dispatchEvent(new Event("bots-changed"));

      if (page.params.botId === id) await goto("/bots");
    } catch (cause) {
      deleteError = cause instanceof Error ? cause.message : "Could not delete this bot.";
    } finally {
      deletingBusy = false;
    }
  }
</script>

{#if bot}
  {#if SettingsDialog}
    <SettingsDialog
      bind:open
      {bot}
      {providers}
      {instances}
      onarchive={archive}
      ondelete={() => {
        deleting = true;
        deleteError = "";
      }}
    />
  {/if}
  <Dialog
    bind:open={deleting}
    title="Delete {bot.configuration?.name ?? 'bot'}?"
    description="The bot and its conversation will disappear from Canopy. This cannot be undone."
    dismissible={!deletingBusy}
  >
    {#if deleteError}<Alert tone="error">{deleteError}</Alert>{/if}
    <DialogActions
      ><Button disabled={deletingBusy} onclick={() => (deleting = false)}>Keep bot</Button><Button
        variant="primary"
        loading={deletingBusy}
        onclick={remove}>Delete bot</Button
      ></DialogActions
    >
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
