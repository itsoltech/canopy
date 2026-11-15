<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import type { UpdatesState } from "./updates.svelte.ts";

  let {
    open = $bindable(false),
    worker,
    updates,
  }: { open?: boolean; worker: ui.WorkerUpdate; updates: UpdatesState } = $props();
</script>

<Dialog bind:open title="Restart Canopy app now?">
  <div class="grid gap-4">
    <p class="text-sm/6 text-muted">
      Restarting stops the running turns on this computer. The app reconnects by itself.
    </p>
    <div class="flex flex-wrap justify-end gap-2">
      <Button size="sm" onclick={() => (open = false)}>Keep waiting</Button>
      <Button
        size="sm"
        variant="primary"
        disabled={updates.active ||
          !worker.desktop?.connected ||
          !!worker.desktop.disabledReason ||
          worker.desktop.phase !== "waiting_idle"}
        onclick={() => {
          open = false;
          void updates.manage({
            action: "desktop",
            workerId: worker.workerId,
            force: true,
            desktopRequestId: worker.desktop?.requestId ?? "",
          });
        }}>Restart now</Button
      >
    </div>
  </div>
</Dialog>
