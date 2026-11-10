<script lang="ts">
  import { connectors, type ConnectorTool } from "@canopy/contracts";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import type { JsonObject } from "#lib/shared/json.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
  import AccountSummary from "./AccountSummary.svelte";
  import AccessPicker from "./AccessPicker.svelte";
  import ToolCatalog from "./ToolCatalog.svelte";
  import ConnectAccountDialog from "./ConnectAccountDialog.svelte";
  import ConnectionError from "./ConnectionError.svelte";

  let {
    account,
    oauthCompletion,
    type,
    workers,
    bots,
    onupdate,
    onremove,
    class: className,
  }: {
    account: connectors.ConnectorAccount;
    oauthCompletion?: connectors.CompleteConnectorOAuthResponse | undefined;
    type: connectors.ConnectorType;
    workers: readonly { id: string; name: string; group?: string; readOnly?: string }[];
    bots: readonly { id: string; name: string }[];
    onupdate: (account: connectors.ConnectorAccount, alreadyConnected?: boolean) => void;
    onremove: (id: string) => void;
    class?: ClassValue;
  } = $props();

  let name = $state(untrack(() => account.name));
  let allWorkers = $state(untrack(() => account.allWorkers));
  let workerIds = $state(untrack(() => [...account.workerIds]));
  let allBots = $state(untrack(() => account.allBots));
  let botIds = $state(untrack(() => [...account.botIds]));
  let busy = $state("");
  let error = $state("");
  let tools = $state<ConnectorTool[]>();
  let reconnecting = $state(false);
  let disconnecting = $state(false);
  let deleting = $state(false);
  let renaming = $state(false);
  let accessOpen = $state(false);
  let previous = untrack(() => account);

  // Follow received changes without discarding an edit the user has started here.
  $effect(() => {
    const next = account;
    untrack(() => {
      if (name === previous.name) name = next.name;

      if (allWorkers === previous.allWorkers) allWorkers = next.allWorkers;

      if (allBots === previous.allBots) allBots = next.allBots;

      if (workerIds.join() === previous.workerIds.join()) workerIds = [...next.workerIds];

      if (botIds.join() === previous.botIds.join()) botIds = [...next.botIds];
      previous = next;
    });
  });

  /** What a save action sends: the new access, or the new name; the revision guards against changes elsewhere. */
  function actionBody(action: string): JsonObject {
    const expectedRevision = account.revision.toString();

    if (action === "access") return { allWorkers, workerIds, allBots, botIds, expectedRevision };

    if (action === "rename") return { id: account.id, name, expectedRevision };

    return {};
  }

  async function run(action: string) {
    if (busy) return;
    busy = action;
    error = "";

    try {
      if (action === "delete") {
        await requestJson("POST", `/api/connectors/${account.id}/delete`, {}, 55000);
        deleting = false;
        onremove(account.id);

        return;
      }

      if (action === "test") {
        const result = decode(
          connectors.TestConnectorResponseSchema,
          await requestJson("POST", `/api/connectors/${account.id}/test`, {}, 35000),
        );

        tools = result.account?.error ? undefined : result.tools;

        if (result.account) onupdate(result.account);
      } else {
        const path = action === "rename" ? "/api/connectors" : `/api/connectors/${account.id}/${action}`;

        const updated = decode(
          connectors.ConnectorAccountResponseSchema,
          await requestJson("POST", path, actionBody(action), 55000),
        ).account!;

        onupdate(updated);
        disconnecting = false;
        renaming = false;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update this account.";

      if (action === "test") tools = undefined;
    } finally {
      busy = "";
    }
  }
</script>

<section aria-label="{type.name} · {account.name}" class={["@container min-w-0", className]}>
  <div class="flex min-w-0 items-center gap-2 px-3">
    <AccountSummary
      {account}
      {type}
      expanded={accessOpen}
      testing={busy === "test"}
      onclick={() => (accessOpen = !accessOpen)}
    />
    <DropdownMenu label="Account actions" placement="bottom-end" sheet>
      {#snippet trigger(props)}
        <IconButton icon="ellipsis-horizontal" label="Actions for {account.name}" {...props} />
      {/snippet}
      <MenuItem
        disabled={!!busy || account.status === "disconnected" || account.status === "needs_reconnect"}
        onselect={() => void run("test")}>Test</MenuItem
      >
      <MenuItem disabled={!!busy} onselect={() => (reconnecting = true)}>Reconnect</MenuItem>
      <MenuItem
        disabled={!!busy}
        onselect={() => {
          name = account.name;
          error = "";
          renaming = true;
        }}>Rename…</MenuItem
      >
      <MenuItem onselect={() => (accessOpen = !accessOpen)}>Edit access</MenuItem>
      <MenuSeparator />
      <MenuItem disabled={!!busy || account.status === "disconnected"} onselect={() => (disconnecting = true)}
        >Disconnect</MenuItem
      >
      <MenuItem danger disabled={!!busy} onselect={() => (deleting = true)}>Delete…</MenuItem>
    </DropdownMenu>
  </div>
  {#if accessOpen}
    <div transition:expand={{ instantReduced: true }}>
      <div class="grid gap-4 border-t border-zinc-950/5 p-3 dark:border-white/8">
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Only these workers and bots can use this account. Threads also follow their permission mode.
        </p>
        <AccessPicker
          label="Workers"
          options={workers}
          bind:all={allWorkers}
          bind:selected={workerIds}
          disabled={!!busy}
        />
        <AccessPicker label="Bots" options={bots} bind:all={allBots} bind:selected={botIds} disabled={!!busy} />
        <div>
          <Button size="sm" loading={busy === "access"} disabled={!!busy} onclick={() => run("access")}
            >Save access</Button
          >
        </div>
      </div>
    </div>
  {/if}
  {#if tools && account.status === "connected"}
    {@const verified = tools}
    <Disclosure class="px-3 pb-3 text-base/5 sm:text-sm/5" summaryClass="py-1">
      {#snippet summary()}Connection verified · {verified.length} {verified.length === 1 ? "tool" : "tools"}{/snippet}
      <ToolCatalog tools={verified} />
    </Disclosure>
  {/if}
  {#if account.status === "error" && account.error}<ConnectionError error={account.error} class="mx-3 mb-3" />{/if}
  {#if error && !renaming}<Alert tone="error" class="mx-3 mb-3">{error}</Alert>{/if}
</section>
<Dialog bind:open={renaming} title="Rename account" dismissible={!busy}>
  <form
    class="grid gap-4"
    onsubmit={(event) => {
      event.preventDefault();
      if (name.trim() && name !== account.name) void run("rename");
    }}
  >
    <Field label="Account name"><Input name="accountName" bind:value={name} maxlength={80} disabled={!!busy} /></Field>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={!!busy} onclick={() => (renaming = false)}>Cancel</Button>
      <Button
        type="submit"
        variant="primary"
        loading={busy === "rename"}
        disabled={!!busy || !name.trim() || name === account.name}>Rename</Button
      >
    </DialogActions>
  </form>
</Dialog>
{#if reconnecting}<ConnectAccountDialog
    bind:open={reconnecting}
    {type}
    {account}
    {oauthCompletion}
    onsave={onupdate}
  />{/if}
<Dialog
  bind:open={disconnecting}
  title="Disconnect {account.name}?"
  description="Computers sharing configuration lose access to this account. You can reconnect it later."
  dismissible={!busy}
>
  <DialogActions
    ><Button disabled={!!busy} onclick={() => (disconnecting = false)}>Keep connected</Button><Button
      loading={busy === "disconnect"}
      onclick={() => run("disconnect")}>Disconnect</Button
    ></DialogActions
  >
</Dialog>
<Dialog
  bind:open={deleting}
  title="Delete {type.name} · {account.name}?"
  description="This removes the account from computers sharing configuration. Workers and bots lose access. A linked computer can restore it for 90 days."
  dismissible={!busy}
>
  <DialogActions
    ><Button disabled={!!busy} onclick={() => (deleting = false)}>Keep account</Button><Button
      variant="danger"
      loading={busy === "delete"}
      onclick={() => run("delete")}>Delete account</Button
    ></DialogActions
  >
</Dialog>
