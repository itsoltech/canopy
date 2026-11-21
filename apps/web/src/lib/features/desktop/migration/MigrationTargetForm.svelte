<script lang="ts">
  import type { DesktopMigrationTarget } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import ChoiceCard from "#lib/shared/ui/ChoiceCard.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  let { onprepare, disabled }: { onprepare: (target: DesktopMigrationTarget) => void; disabled: boolean } = $props();
  let kind = $state<DesktopMigrationTarget["kind"]>("move");
  let host = $state("");

  function prepare(event: SubmitEvent) {
    event.preventDefault();
    const invitation = host.trim();

    if (invitation) onprepare({ kind, invitation });
  }
</script>

<p class="text-pretty text-muted">
  Bring your Canopy history to a server. Your worker keeps running on this computer with the same repositories and CLI
  sessions.
</p>
<form class="grid min-w-0 gap-5" onsubmit={prepare}>
  <fieldset class="min-w-0">
    <legend class="mb-2 font-medium">What should the server do?</legend>
    <div class="grid gap-3 sm:grid-cols-2">
      <ChoiceCard
        name="migration-kind"
        title="Move this gateway"
        description="Restore this gateway on a new server and keep its identity and existing pairings."
        checked={kind === "move"}
        onchange={() => (kind = "move")}
      />
      <ChoiceCard
        name="migration-kind"
        title="Join a shared server"
        description="Import this computer’s data into an existing gateway and review any conflicts before merging."
        checked={kind === "join"}
        onchange={() => (kind = "join")}
      />
    </div>
  </fieldset>

  <Field label="Server SSH host" description="Use a trusted SSH alias or a target in the form user@host.">
    <Input
      bind:value={host}
      name="migration-host"
      autocomplete="off"
      autocapitalize="none"
      spellcheck={false}
      maxlength={253}
      required
    />
  </Field>

  <Disclosure>
    {#snippet summary()}Prepare the server for SSH{/snippet}
    <div class="space-y-2 pt-2 pl-6 text-pretty text-muted">
      <p>
        Verify the server’s SSH host key on this computer first. Set up SSH access that works without passwords or other
        prompts.
      </p>
      {#if kind === "move"}
        <p>Ask your server administrator to configure Canopy’s migration receiver and an empty PostgreSQL database.</p>
      {:else}
        <p>Ask the shared server’s administrator to enable Canopy’s migration receiver for imports.</p>
      {/if}
    </div>
  </Disclosure>

  <div><Button type="submit" variant="primary" disabled={disabled || !host.trim()}>Run trial</Button></div>
</form>
