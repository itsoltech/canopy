<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { goto } from "$app/navigation";
  import { requestJson } from "#lib/shared/http.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";

  /** Archives a project the owner added: its workspaces and threads leave the app, files on the workers stay. */
  let { project, threads }: { project: ui.Project; threads: number } = $props();

  let open = $state(false);
  let busy = $state(false);

  const effect = $derived(
    threads === 0
      ? `This archives “${project.name}”.`
      : `This archives “${project.name}” and ${threads === 1 ? "its thread" : `its ${threads} threads`}.`,
  );

  async function archive() {
    busy = true;

    try {
      await requestJson("POST", `/api/projects/${encodeURIComponent(project.id)}/archive`, {}, 65_000);
      open = false;
      toast("Project archived");
      await goto("/settings/projects");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not archive the project. Try again.", { tone: "error" });
    } finally {
      busy = false;
    }
  }
</script>

<SettingsRow title="Archive project" description="Remove the project and its threads from Canopy. Files stay on disk.">
  {#snippet control()}<Button variant="danger" onclick={() => (open = true)}>Archive project…</Button>{/snippet}
</SettingsRow>

<Dialog bind:open title="Archive project?" description={effect}>
  <p class="text-base/6 text-pretty break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Running turns stop. Canopy cancels the project's schedules. Files in its directories stay on the workers.
  </p>
  <div class="mt-5 flex flex-wrap justify-end gap-2">
    <Button data-autofocus disabled={busy} onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={() => void archive()}>Archive project</Button>
  </div>
</Dialog>
