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
  import type { LinkedWorker } from "./worker-records.svelte.ts";

  let {
    worker,
    setup,
    linked,
    onchanged,
    class: className,
  }: {
    worker: ui.Worker;
    setup: WorkerSetup;
    /** Another computer's worker: only its name changes from here, at its home. */
    linked?: LinkedWorker;
    onchanged?: () => void;
    class?: ClassValue;
  } = $props();

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
      onchanged?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not change the worker. Try again.";
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
    {#if !linked && !worker.nodeId && worker.cliImport}<MenuItem
        href={`/settings/import?worker=${encodeURIComponent(worker.id)}`}
        disabled={!worker.online || Boolean(worker.revokedAt)}>Import from this computer</MenuItem
      >{/if}
    <MenuItem disabled={Boolean(linked?.readOnly)} onselect={() => choose("rename")}>Rename</MenuItem>
    {#if !linked}<MenuItem disabled={Boolean(worker.revokedAt) || !setup.gatewayUrl} onselect={() => choose("rotate")}
        >Rotate credential</MenuItem
      >
      <MenuItem danger disabled={Boolean(worker.revokedAt)} onselect={() => choose("revoke")}>Revoke</MenuItem>
      <MenuItem danger onselect={() => choose("archive")}>Archive</MenuItem>{/if}
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
          >This credential is shown only once. Put it in worker.json on that computer, keep mode 0600, and restart the
          worker. Do not change data_dir or ca_file.</Alert
        >
        <CommandBlock text={config} label="worker.json · private" />
      {:else}<p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          This disconnects <strong>{worker.name}</strong> and replaces its credential. The old credential stops working now.
          Copy the new one before you close this dialog.
        </p>{/if}
    {:else if action === "revoke"}
      <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        <strong>{worker.name}</strong> disconnects now and cannot reconnect. Its workspaces, threads and files stay. Processes
        already running on that computer can continue, so stop the worker there. To use it again, add it as a new worker.
      </p>
    {:else}
      <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        This revokes access for <strong>{worker.name}</strong> and archives its workspaces. Its threads stay readable but
        cannot run. Files on that computer stay. Archiving does not stop processes there, so stop the worker on that computer.
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
