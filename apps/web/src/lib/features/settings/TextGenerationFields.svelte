<script lang="ts">
  import { Provider } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { modelOption, modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { useSettings } from "./settings-state.svelte.ts";

  let { class: className }: { class?: ClassValue } = $props();
  const settings = useSettings();
  const overview = useOverview();
  const catalog = useModelCatalog();
  const value = $derived(settings.textGeneration);
  const options = $derived([...new Map(overview.workers.flatMap((worker) =>
    modelOptions({ worker, catalog: catalog.of(worker.id), threads: overview.threads.values() }).filter((o) => o.model),
  ).map((o) => [o.key, o])).values()]);
  const provider = $derived(providerKeyOf(value.provider));
  const profileId = $derived(value.profileId === "native" ? "" : value.profileId);
  const worker = $derived(overview.workers.find((w) => w.providerInstances.some((i) => i.harness === value.provider && i.id === (profileId || "native") && i.available && i.enabled)));
  const option = $derived(value.model && provider
    ? options.find((o) => o.provider === provider && o.profileId === profileId && o.model === value.model)
      ?? modelOption(provider, profileId, profileId || "Device login", value.model, worker ? catalog.of(worker.id) : undefined)
    : undefined);

  function select(next: ModelOption | undefined) {
    if (!next) return;
    void settings.updateTextGeneration({
      provider: Provider[next.provider], profileId: next.profileId, model: next.model,
      effort: next.efforts.some((e) => e.id === "low") ? "low" : "",
    });
  }
</script>

<div class={["grid gap-6", className]}>
  <SettingsGroup title="Text generation">
    {#snippet actions()}
      <Button size="sm" icon="arrow-path" disabled={!value.model} onclick={() => settings.updateTextGeneration({ provider: Provider.UNSPECIFIED, profileId: "", model: "", effort: "" })}>Reset to default</Button>
    {/snippet}
    <SettingsRow title="Text generation model" description="Used for thread titles and other generated text">
      <div class="grid min-w-0 gap-2 pt-3">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <ModelControls
            {options}
            bind:option={() => option, select}
            bind:effort={() => value.effort || undefined, (effort) => void settings.updateTextGeneration({ effort: effort ?? "" })}
            workerId={worker?.id}
            allowCustom={false}
          />
          {#if option}<p class="min-w-0 truncate text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{option.provider === "CLAUDE" ? "Claude" : "Codex"} · {option.profileName}</p>{/if}
        </div>
        {#if !value.model}
          <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Automatic: a small, fast model from the thread’s provider instance at low effort when supported. Falls back to the thread’s model.</p>
        {/if}
      </div>
    </SettingsRow>
  </SettingsGroup>

  <SettingsGroup title="Advanced">
    <div class="p-4">
      <Field label="Thread title instructions" description="Appended to the prompt for new and regenerated thread titles">
        <Textarea name="threadTitleInstructions" rows={3} maxlength={4000} value={value.threadTitleInstructions} placeholder="Keep titles to a few words. Lead with the main subject." onchange={(event) => settings.updateTextGeneration({ threadTitleInstructions: event.currentTarget.value })} />
      </Field>
    </div>
  </SettingsGroup>
</div>
