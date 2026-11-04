<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { PluginState } from "./plugin-state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SourceCredentialPicker from "./SourceCredentialPicker.svelte";

  let { state: controller, class: className }: { state: PluginState; class?: ClassValue } = $props();
  let command = $state("");
  let credential = $state("");
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <Field
    label="Marketplace or install command"
    description="Paste /plugin marketplace add owner/repo, an HTTPS Git source with #ref, or /plugin install name@marketplace."
  >
    <Input name="marketplace-command" bind:value={command} placeholder="/plugin marketplace add owner/repo" />
  </Field>
  <SourceCredentialPicker bind:value={credential} onchange={() => (controller.preview = undefined)} />
  <div class="flex flex-wrap gap-2">
    <Button
      size="sm"
      variant="secondary"
      disabled={controller.busy || controller.environment.busy || !command.trim()}
      onclick={() => {
        if (
          /^(?:\/plugin install |claude plugin install |codex plugin add )/.test(command.trim()) ||
          /^[a-z0-9-]+@[a-z0-9-]+$/.test(command.trim())
        )
          controller.command(command);
        else void controller.resolve(command, credential);
      }}>{controller.busy ? "Reading marketplace…" : "Preview command"}</Button
    >
  </div>
  {#if controller.error}<Alert tone="error">{controller.error}</Alert>{/if}
  {#if controller.preview?.marketplace}
    {@const market = controller.preview.marketplace}
    <div class="grid min-w-0 gap-3 rounded-lg bg-zinc-950/3 p-4 dark:bg-white/4">
      <h3 class="text-base font-medium text-balance">{market.name} · {market.plugins.length} plugins</h3>
      <p class="font-mono text-base wrap-anywhere sm:text-sm">
        {market.source?.url}<br />Commit {market.source?.commit}
      </p>
      <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
        Saving the catalog does not enable code. Each plugin has its own review and assignment.
      </p>
      <ul role="list" class="grid max-h-56 gap-2 overflow-auto text-base sm:text-sm">
        {#each market.plugins as plugin (plugin.artifact?.name)}<li class="wrap-anywhere">
            {plugin.artifact?.name}{plugin.unavailableReason ? ` · ${plugin.unavailableReason}` : ""}
          </li>{/each}
      </ul>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" disabled={controller.environment.busy} onclick={() => controller.saveMarketplace()}
          >{market.id ? "Save updated catalog" : "Add marketplace"}</Button
        >
        <Button size="sm" variant="ghost" onclick={() => (controller.preview = undefined)}>Cancel preview</Button>
      </div>
    </div>
  {/if}
</div>
