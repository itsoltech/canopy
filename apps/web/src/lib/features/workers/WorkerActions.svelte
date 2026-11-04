<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import { workerAction } from "./actions.ts";
  import type { WorkerSetup } from "./worker-setup.svelte.ts";

  let { worker, setup, class: className }: { worker: ui.Worker; setup: WorkerSetup; class?: ClassValue } = $props();
  let action = $state<"rename" | "rotate" | "revoke" | "archive">("rename");
  let open = $state(false);
  let name = $state("");
  let busy = $state(false);
  let error = $state("");
  let credential = $state("");

  const titles = {
    rename: "Rename worker",
    rotate: "Rotate credential",
    revoke: "Revoke worker",
    archive: "Archive worker",
  };

  const config = $derived(JSON.stringify({ gateway_url: setup.gatewayUrl, worker_id: worker.id, credential }, null, 2));

  function choose(next: typeof action) {
    action = next;
    name = worker.name;
    error = "";
    credential = "";
    open = true;
  }

  $effect(() => {
    if (!open) credential = "";
  });

  async function save() {
    busy = true;
    error = "";

    try {
      if (action === "rename") await workerAction("rename", { workerId: worker.id, name });
      else if (action === "rotate") credential = (await workerAction("rotate", { workerId: worker.id })).credential;
      else await workerAction(action, { workerId: worker.id });

      if (action !== "rotate") open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Worker operation failed";
    } finally {
      busy = false;
    }
  }
</script>

<div class={className}>
  <DropdownMenu label={`Actions for ${worker.name}`} placement="bottom-end">
    {#snippet trigger(props)}<IconButton
        icon="ellipsis-horizontal"
        label={`Actions for ${worker.name}`}
        {...props}
      />{/snippet}
    <MenuItem onselect={() => choose("rename")}>Rename</MenuItem>
    <MenuItem disabled={Boolean(worker.revokedAt) || !setup.gatewayUrl} onselect={() => choose("rotate")}
      >Rotate credential</MenuItem
    >
    <MenuItem danger disabled={Boolean(worker.revokedAt)} onselect={() => choose("revoke")}>Revoke</MenuItem>
    <MenuItem danger onselect={() => choose("archive")}>Archive</MenuItem>
  </DropdownMenu>
</div>
<Dialog bind:open title={titles[action]} dismissible={!busy}>
  <form
    class="grid gap-4"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if action === "rename"}
      <Field label="Machine name"
        ><Input name="rename-worker" bind:value={name} maxlength={200} required data-autofocus /></Field
      >
    {:else if action === "rotate"}
      {#if credential}
        <Alert tone="warning"
          >Shown once. Replace the credential in this machine’s worker.json, keep mode 0600, and restart the worker.
          Keep your existing data_dir and ca_file settings.</Alert
        >
        <CommandBlock text={config} label="worker.json · private" />
      {:else}<p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          Disconnect <strong>{worker.name}</strong> and replace its credential. The old credential stops working immediately.
          The new one is shown only here; copy it before closing.
        </p>{/if}
    {:else if action === "revoke"}
      <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        Revoke access for <strong>{worker.name}</strong>? The worker disconnects immediately and cannot reconnect.
        Existing workspaces, conversations and files stay in place. Running processes on the device may continue; stop
        the worker there. Add it again with a new enrollment to restore access as a new worker.
      </p>
    {:else}
      <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        Archive <strong>{worker.name}</strong>? Access is revoked and its project workspaces are archived, so no new
        conversations can run there. Existing threads and their history remain readable but cannot run. Files on the
        machine are kept. Stop the worker on the device; archiving does not stop its local processes.
      </p>
    {/if}
    <div class="flex justify-end gap-2">
      <Button disabled={busy} onclick={() => (open = false)}>{credential ? "Done" : "Cancel"}</Button>
      {#if !credential}<Button
          type="submit"
          variant={action === "revoke" || action === "archive" ? "danger" : "primary"}
          loading={busy}
          disabled={action === "rename" && !name.trim()}>{action === "rename" ? "Save name" : titles[action]}</Button
        >{/if}
    </div>
  </form>
</Dialog>
