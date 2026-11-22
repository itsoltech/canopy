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
  import type { AccessChoice } from "@canopy/domain/access-picker";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import AccountSummary from "./AccountSummary.svelte";
  import SlackMessages from "./SlackMessages.svelte";
  import AccessPicker from "#lib/features/access/AccessPicker.svelte";
  import type { AccessOption } from "#lib/features/access/access-options.ts";
  import ToolCatalog from "./ToolCatalog.svelte";
  import ConnectAccountDialog from "./ConnectAccountDialog.svelte";
  import ConnectionError from "./ConnectionError.svelte";

  let {
    account,
    oauthCompletion,
    type,
    projects,
    projectsLoaded,
    bots,
    onupdate,
    onremove,
    class: className,
  }: {
    account: connectors.ConnectorAccount;
    oauthCompletion?: connectors.CompleteConnectorOAuthResponse | undefined;
    type: connectors.ConnectorType;
    projects: readonly AccessOption[];
    projectsLoaded: boolean;
    bots: readonly AccessOption[];
    onupdate: (account: connectors.ConnectorAccount, alreadyConnected?: boolean) => void;
    onremove: (id: string) => void;
    class?: ClassValue;
  } = $props();

  const settings = useSettings();
  let name = $state(untrack(() => account.name));

  /** The access being saved; the pickers show it until the account comes back. */
  let pending = $state<{ group: "projects" | "bots"; choice: AccessChoice }>();

  let busy = $state("");
  let error = $state("");
  let tools = $state<ConnectorTool[]>();
  let reconnecting = $state(false);
  let disconnecting = $state(false);
  let deleting = $state(false);
  let renaming = $state(false);
  let accessOpen = $state(false);
  let actionsOpen = $state(false);
  let previous = untrack(() => account);

  // Follow received changes without discarding an edit the user has started here.
  $effect(() => {
    const next = account;
    untrack(() => {
      if (name === previous.name) name = next.name;
      previous = next;
    });
  });

  /** What a save action sends: the new access, or the new name; the revision guards against changes elsewhere. */
  function actionBody(action: string): JsonObject {
    const expectedRevision = account.revision.toString();

    if (action === "access" && pending) {
      const { group, choice } = pending;

      if (group === "projects")
        return {
          allProjects: choice.all,
          projectIds: [...choice.ids],
          allBots: account.allBots,
          botIds: [...account.botIds],
          expectedRevision,
        };

      return {
        // A bot-only edit on an older gateway must carry its existing worker access.
        ...(account.allProjects === undefined && { allWorkers: account.allWorkers, workerIds: [...account.workerIds] }),
        allBots: choice.all,
        botIds: [...choice.ids],
        expectedRevision,
      };
    }

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
      pending = undefined;
    }
  }

  /** Access saves as soon as a picker closes with a change, like the other switches in Settings. */
  function saveAccess(group: "projects" | "bots", choice: AccessChoice) {
    if (busy || (group === "projects" && account.allProjects === undefined)) return;
    pending = { group, choice };
    void run("access");
  }
</script>

<section aria-label="{type.name} · {account.name}" class={["@container min-w-0", className]}>
  <div
    data-active={accessOpen || actionsOpen}
    class="flex min-w-0 items-center gap-2 px-3 focus-within:bg-zinc-950/3 hover:bg-zinc-950/3 data-[active=true]:bg-zinc-950/3 dark:focus-within:bg-white/4 dark:hover:bg-white/4 dark:data-[active=true]:bg-white/4"
  >
    <AccountSummary
      {account}
      {type}
      expanded={accessOpen}
      testing={busy === "test"}
      onclick={() => (accessOpen = !accessOpen)}
    />
    <DropdownMenu bind:open={actionsOpen} label="Account actions" placement="bottom-end" sheet>
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
      <div class="grid gap-3 border-t border-zinc-950/5 p-3 dark:border-white/8">
        {#if settings.moduleEnabled("threads")}
          {#if account.allProjects === undefined}
            <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Update the gateway to manage project access.</p>
          {:else}
            <AccessPicker
              label="Projects"
              description="Each thread in a selected project can use this account within its permission mode."
              icon="folder"
              options={projects}
              all={pending?.group === "projects" ? pending.choice.all : account.allProjects}
              ids={pending?.group === "projects" ? pending.choice.ids : account.projectIds}
              saving={pending?.group === "projects"}
              disabled={!!busy || !projectsLoaded}
              onchange={(next) => saveAccess("projects", next)}
            />
          {/if}
        {/if}
        {#if settings.moduleEnabled("bots")}
          <AccessPicker
            label="Bots"
            icon="chat-bubble-left-right"
            options={bots}
            all={pending?.group === "bots" ? pending.choice.all : account.allBots}
            ids={pending?.group === "bots" ? pending.choice.ids : account.botIds}
            saving={pending?.group === "bots"}
            disabled={!!busy || !botList.loaded || Boolean(botList.error)}
            onchange={(next) => saveAccess("bots", next)}
          />
        {/if}
      </div>
    </div>
  {/if}
  {#if type.id === "slack" && settings.moduleEnabled("bots")}<SlackMessages
      {account}
      {oauthCompletion}
      {onupdate}
      onreconnect={() => (reconnecting = true)}
    />{/if}
  {#if tools && account.status === "connected"}
    {@const verified = tools}
    {#if verified.length}
      <Disclosure class="px-3 pb-3 text-base/5 sm:text-sm/5" summaryClass="py-1">
        {#snippet summary()}Connection verified · {verified.length} {verified.length === 1 ? "tool" : "tools"}{/snippet}
        <ToolCatalog tools={verified} />
      </Disclosure>
    {:else}
      <p role="status" class="px-3 pb-3 text-base/5 sm:text-sm/5">Connection verified. No tools available.</p>
    {/if}
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
  description={type.id === "slack"
    ? "Computers sharing configuration lose tool access. Message reception pauses and routes stay saved. Reconnect and authorize messages to resume."
    : "Computers sharing configuration lose access to this account. You can reconnect it later."}
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
  description={type.id === "slack"
    ? "This removes the account from computers sharing configuration. Threads and bots lose tool access. Message reception stops and route history stays saved. A linked computer can restore the account for 90 days."
    : "This removes the account from computers sharing configuration. Threads and bots lose access. A linked computer can restore it for 90 days."}
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
