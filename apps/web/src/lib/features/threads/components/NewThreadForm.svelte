<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { enhance } from "$app/forms";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import ThreadSettingsFields from "./ThreadSettingsFields.svelte";

  /** New main thread in one of the project's workspaces; redirects to it. */
  let { project, error }: { project: ui.Project; error?: string | undefined } = $props();
  const overview = useOverview();

  // svelte-ignore state_referenced_locally
  let workspaceId = $state(project.workspaces.length === 1 ? (project.workspaces[0]?.id ?? "") : "");
  let busy = $state(false);
  const workspace = $derived(project.workspaces.find((w) => w.id === workspaceId));
  const worker = $derived(overview.worker(workspace?.workerId ?? ""));
  const clientRequestId = crypto.randomUUID();
</script>

<form
  method="POST"
  action="?/createThread"
  class="grid gap-4"
  use:enhance={() => {
    busy = true;
    return async ({ update }) => {
      await update();
      busy = false;
    };
  }}
>
  <input type="hidden" name="clientRequestId" value={clientRequestId} />
  <Field label="Workspace">
    <Select name="workspaceId" bind:value={workspaceId} required>
      <option value="" disabled>Choose a workspace…</option>
      {#each project.workspaces as ws (ws.id)}
        {@const owner = overview.worker(ws.workerId)}
        <option value={ws.id}>{owner?.name ?? "Unknown worker"}{owner?.online ? "" : " (offline)"}: {ws.rootPath}</option>
      {/each}
    </Select>
  </Field>
  <Field label="Task" optional>
    <Textarea name="message" rows={3} placeholder="What should the agent do?" />
  </Field>
  <Field label="Title" optional>
    <Input name="title" placeholder="Short label for the thread list" autocomplete="off" maxlength={200} />
  </Field>
  <ThreadSettingsFields {worker} />
  {#if worker && !worker.online}<Alert tone="warning">{worker.name} is offline. The thread starts when it reconnects.</Alert>{/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div><Button type="submit" variant="primary" icon="sparkles" loading={busy}>Start thread</Button></div>
</form>
