<script lang="ts">
  import { connectors, type ConnectorTool } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import ConnectorIcon from "./ConnectorIcon.svelte";
  import AccessPicker from "./AccessPicker.svelte";
  import ToolCatalog from "./ToolCatalog.svelte";
  import ConnectAccountDialog from "./ConnectAccountDialog.svelte";
  import { accountStatus } from "./api.ts";

  let {
    account,
    type,
    workers,
    bots,
    onupdate,
    onremove,
    class: className,
  }: {
    account: connectors.ConnectorAccount;
    type: connectors.ConnectorType;
    workers: readonly { id: string; name: string }[];
    bots: readonly { id: string; name: string }[];
    onupdate: (account: connectors.ConnectorAccount) => void;
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

        tools = result.tools;

        if (result.account) onupdate(result.account);
      } else {
        const path = action === "rename" ? "/api/connectors" : `/api/connectors/${account.id}/${action}`;

        const body =
          action === "access"
            ? { allWorkers, workerIds, allBots, botIds, expectedRevision: account.revision.toString() }
            : action === "rename"
              ? { id: account.id, name, expectedRevision: account.revision.toString() }
              : {};

        const updated = decode(
          connectors.ConnectorAccountResponseSchema,
          await requestJson("POST", path, body, 55000),
        ).account!;

        onupdate(updated);
        disconnecting = false;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update this account.";
    } finally {
      busy = "";
    }
  }
</script>

<section
  aria-label="{type.name} · {account.name}"
  class={["grid min-w-0 gap-5 rounded-xl border border-zinc-950/10 p-4 sm:p-5 dark:border-white/10", className]}
>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="grid min-w-0 gap-1 text-base/6 sm:text-sm/6">
      <p class="flex min-w-0 items-center gap-2 font-medium">
        <ConnectorIcon type={type.id} /><span class="truncate">{type.name} · {account.name}</span>
      </p>
      <p
        class={account.status === "connected"
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-amber-700 dark:text-amber-400"}
      >
        {accountStatus(account.status)}
      </p>
      <p class="text-zinc-500 dark:text-zinc-400">
        Last used: {account.lastUsedAt ? new Date(timestampMs(account.lastUsedAt)).toLocaleString() : "Not yet"}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <Button
        size="sm"
        loading={busy === "test"}
        disabled={!!busy || account.status === "disconnected" || account.status === "needs_reconnect"}
        onclick={() => run("test")}>Test</Button
      ><Button size="sm" disabled={!!busy} onclick={() => (reconnecting = true)}>Reconnect</Button><Button
        size="sm"
        disabled={!!busy || account.status === "disconnected"}
        onclick={() => (disconnecting = true)}>Disconnect</Button
      ><Button size="sm" variant="danger" disabled={!!busy} onclick={() => (deleting = true)}>Delete…</Button>
    </div>
  </div>
  <div class="flex flex-wrap items-end gap-2">
    <div class="min-w-0 flex-1">
      <Field label="Account name"><Input bind:value={name} maxlength={80} disabled={!!busy} /></Field>
    </div>
    <div class="pb-px">
      <Button
        size="sm"
        disabled={!!busy || !name.trim() || name === account.name}
        loading={busy === "rename"}
        onclick={() => run("rename")}>Rename</Button
      >
    </div>
  </div>
  <Disclosure summaryClass="py-1 text-base/6 sm:text-sm/6">
    {#snippet summary()}Access · {account.allWorkers ? "All workers" : `${account.workerIds.length} workers`} · {account.allBots
        ? "All bots"
        : `${account.botIds.length} bots`}{/snippet}
    <div class="grid gap-5 pt-4">
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
  </Disclosure>
  {#if tools}<ToolCatalog {tools} />{/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
</section>
{#if reconnecting}<ConnectAccountDialog bind:open={reconnecting} {type} {account} onsave={onupdate} />{/if}
<Dialog
  bind:open={disconnecting}
  title="Disconnect {account.name}?"
  description="Workers and bots will lose access immediately. You can reconnect this account later."
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
  description="The account is disconnected and removed from Canopy. Workers and bots lose access immediately. To use it again, connect it as a new account."
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
