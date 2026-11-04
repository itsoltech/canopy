<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { PluginState } from "./plugin-state.svelte.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import SourceCredentialPicker from "./SourceCredentialPicker.svelte";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";

  let {
    state: controller,
    open = $bindable(false),
    step = $bindable(0),
    class: className,
  }: { state: PluginState; open?: boolean; step?: number; class?: ClassValue } = $props();

  let command = $state("");
  let credential = $state("");
</script>

<EnvironmentSheet
  bind:open
  bind:step
  title={controller.preview?.marketplace?.id ? "Update marketplace" : "Add marketplace or plugin"}
  steps={["Choose source", "Preview & confirm"]}
  busy={controller.busy || controller.environment.busy}
  error={controller.error || controller.environment.error}
  nextLabel="Preview command"
  nextDisabled={!command.trim()}
  submitLabel={controller.preview?.marketplace?.id ? "Save updated catalog" : "Add marketplace"}
  submitDisabled={!controller.preview}
  onnext={async () => {
    if (
      /^(?:\/plugin install |claude plugin install |codex plugin add )/.test(command.trim()) ||
      /^[a-z0-9-]+@[a-z0-9-]+$/.test(command.trim())
    ) {
      controller.command(command);
      if (controller.draft) open = false;
      return false;
    }
    await controller.resolve(command, credential);
    return Boolean(controller.preview);
  }}
  onsave={async () => {
    await controller.saveMarketplace();
    if (!controller.preview) open = false;
  }}
  class={className}
>
  {#snippet children(current)}
    {#if current === 0}
      <Field
        label="Marketplace or install command"
        description="Paste /plugin marketplace add owner/repo, an HTTPS Git source with #ref, or /plugin install name@marketplace."
      >
        <Input
          name="marketplace-command"
          bind:value={command}
          required
          maxlength={4096}
          oninput={() => (controller.preview = undefined)}
          placeholder="/plugin marketplace add owner/repo"
        />
      </Field>
      <SourceCredentialPicker bind:value={credential} onchange={() => (controller.preview = undefined)} />
    {:else if controller.preview?.marketplace}
      {@const market = controller.preview.marketplace}
      <div class="grid min-w-0 gap-3 rounded-lg bg-zinc-950/3 p-4 dark:bg-white/4">
        <h3 class="text-base font-medium text-balance wrap-anywhere">
          {market.name} · {market.plugins.length} plugins
        </h3>
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
      </div>
    {:else}<p class="text-base text-muted sm:text-sm">
        {controller.busy ? "Reading marketplace…" : "No catalog preview. Go Back to choose a source."}
      </p>
    {/if}
  {/snippet}
</EnvironmentSheet>
