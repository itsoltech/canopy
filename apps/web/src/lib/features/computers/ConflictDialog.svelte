<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSharedConfig } from "./shared-config.svelte.ts";
  import VersionValue from "./VersionValue.svelte";

  /** Both versions of an item (changed on two computers while apart, or different when first shared), field by field. Nothing is chosen for the user. */
  let { conflict, open = $bindable(false) }: { conflict: ui.SharedConfigConflict; open?: boolean } = $props();
  const overview = useOverview();
  const shared = useSharedConfig();
  const other = $derived(overview.machine(conflict.nodeId) ?? "The other computer");
  let busy = $state<"keep_local" | "keep_remote">();
  let error = $state("");

  async function keep(action: "keep_local" | "keep_remote") {
    busy = action;
    error = "";

    try {
      await shared.manage(action, conflict.key, conflict.nodeId);
      open = false;
      toast(action === "keep_local" ? `Kept this computer’s ${conflict.label}` : `Using ${other}’s ${conflict.label}`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save the choice";
    } finally {
      busy = undefined;
    }
  }
</script>

<Dialog
  bind:open
  title={`${conflict.label} differs on two computers`}
  description={`This computer and ${other} have different versions. Choose the one every linked computer should use.`}
>
  <div class="grid min-w-0 gap-5">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <dl class="grid min-w-0 gap-4">
      {#each conflict.fields as field (field.name)}
        <div class="grid min-w-0 gap-1.5">
          <dt class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{field.name}</dt>
          <dd class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <VersionValue computer="This computer" value={field.local} />
            <VersionValue computer={other} value={field.remote} />
          </dd>
        </div>
      {/each}
    </dl>
    <DialogActions>
      <Button disabled={Boolean(busy)} loading={busy === "keep_remote"} onclick={() => keep("keep_remote")}
        >Keep {other}’s</Button
      >
      <Button disabled={Boolean(busy)} loading={busy === "keep_local"} onclick={() => keep("keep_local")}
        >Keep this computer’s</Button
      >
    </DialogActions>
  </div>
</Dialog>
