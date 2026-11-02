<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { modelOption } from "#lib/features/models/catalog.ts";
  import BotAvatar from "../components/BotAvatar.svelte";
  import { mascotShapes } from "../mascot.ts";
  import MascotFace from "../components/MascotFace.svelte";
  import CreateBotWizard from "../wizard/CreateBotWizard.svelte";
  import EditBotAppearance from "../wizard/EditBotAppearance.svelte";
  import type { BotAppearanceDraft, BotProviderInstance, CreateBotDraft } from "../wizard/draft.ts";
  import GallerySection from "./GallerySection.svelte";
  import Segmented from "./Segmented.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const instances: readonly BotProviderInstance[] = [
    { id: "codex-personal", name: "Codex · Personal", provider: "CODEX", models: [
      { ...modelOption("CODEX", "codex-personal", "Personal", "gpt-6.1-sol", undefined), name: "GPT-6.1 Sol", isDefault: true },
      { ...modelOption("CODEX", "codex-personal", "Personal", "gpt-6-luna", undefined), name: "GPT-6 Luna", efforts: [], defaultEffort: undefined },
    ] },
    { id: "claude-team", name: "Claude · Team", provider: "CLAUDE", models: [
      { ...modelOption("CLAUDE", "claude-team", "Team", "claude-opus-5-5", undefined), name: "Opus 5.5", isDefault: true },
      modelOption("CLAUDE", "claude-team", "Team", "sonnet", undefined),
    ] },
    { id: "codex-lab", name: "Codex · Lab", provider: "CODEX", models: [] },
  ];
  let open = $state(false);
  let editOpen = $state(false);
  let scenario = $state<"success" | "error" | "empty">("success");
  let created = $state<CreateBotDraft[]>([]);
  let appearance = $state<BotAppearanceDraft>({ name: "Orbit", shape: "spark", color: "#8b5cf6" });
  let saved = $state("No bot created yet.");
  const existingNames = $derived(["Canopy Bot", "T3 Bot", appearance.name, ...created.map((b) => b.name)]);

  async function create(draft: CreateBotDraft) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (scenario === "error") throw new Error("The provider is unavailable. Your choices are kept — try again.");
    created = [...created, draft];
    saved = JSON.stringify(draft, null, 2);
  }
</script>

<GallerySection title="Create & edit a Bot" description="Live appearance, custom colour and the existing model/effort pickers. Canopy Bot, T3 Bot and Orbit are already taken. Mock saves take 900 ms; nothing is sent to a gateway." class={className}>
  <div class="flex flex-wrap items-center gap-3">
    <Button variant="primary" onclick={() => (open = true)}>Create New Bot</Button>
    <Button onclick={() => (editOpen = true)}>Edit Bot appearance</Button>
    <BotAvatar participant={{ id: 'editable-orbit', name: appearance.name, kind: 'bot' }} {appearance} size="lg" label={appearance.name} />
    <Segmented label="Wizard scenario" bind:value={scenario} options={[{ value: 'success', label: 'Success' }, { value: 'error', label: 'Save error' }, { value: 'empty', label: 'No providers' }]} />
  </div>
  <div class="flex flex-wrap items-center gap-2">
    {#each mascotShapes as shape (shape.id)}
      <div class="grid justify-items-center gap-1">
        <MascotFace shape={shape.id} color="#8b5cf6" label={shape.label} class="size-10" />
        <MascotFace shape={shape.id} color="#fef3c7" class="size-4" />
      </div>
    {/each}
  </div>
  <div class="grid gap-2">
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">{created.length} bots created in this gallery session.</p>
    <pre class="overflow-x-auto rounded-lg bg-zinc-950/3 p-3 text-sm/6 dark:bg-white/5" aria-label="Last created bot draft">{saved}</pre>
    <div class="flex flex-wrap gap-2">
      {#each created as bot (bot.name)}<BotAvatar participant={{ id: bot.name, name: bot.name, kind: 'bot' }} appearance={bot} label={bot.name} />{/each}
    </div>
  </div>
  <CreateBotWizard bind:open instances={scenario === 'empty' ? [] : instances} {existingNames} oncreate={create} />
  <EditBotAppearance bind:open={editOpen} value={appearance} {existingNames} onsave={async (draft) => { await new Promise((resolve) => setTimeout(resolve, 600)); appearance = draft; }} />
</GallerySection>
