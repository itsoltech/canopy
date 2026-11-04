<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { pluginComponents, pluginHarnesses } from "@canopy/domain/plugin-components";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import SkillDestinations from "./SkillDestinations.svelte";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";
  import type { PluginState } from "./plugin-state.svelte.ts";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";

  let {
    state: controller,
    skill = $bindable(),
    class: className,
  }: { state: PluginState; skill: ui.LibrarySkill | undefined; class?: ClassValue } = $props();

  const artifact = $derived(
    controller.latest ? controller.candidate?.artifact : controller.previous?.assignment?.artifact,
  );

  const components = $derived(artifact ? pluginComponents(artifact.files) : []);

  let step = $state(0);

  $effect(() => {
    if (!skill) step = 0;
  });
</script>

<EnvironmentSheet
  bind:open={
    () => Boolean(controller.draft),
    (value) => {
      if (!value) controller.draft = undefined;
    }
  }
  title={controller.previous ? "Edit plugin" : "Add plugin"}
  steps={["Review code", "Assign computers", "Confirm version"]}
  bind:step
  busy={controller.environment.busy}
  error={controller.error || controller.environment.error}
  submitLabel={controller.previous ? "Approve and save plugin" : "Approve and add plugin"}
  submitDisabled={!controller.confirmed || controller.revision !== controller.environment.snapshot.revision}
  onsave={() => controller.savePlugin()}
  class={className}
>
  {#snippet children(current)}
    {#if skill && controller.marketplace && controller.candidate && artifact}
      {#if current === 0}
        <div class="grid min-w-0 gap-2">
          <h3 class="text-base font-semibold text-balance wrap-anywhere">
            Review {artifact.name}@{controller.marketplace.name}
          </h3>
          <p class="font-mono text-base wrap-anywhere sm:text-sm">
            Commit {controller.latest ? controller.marketplace.source?.commit : controller.previous?.commit}
          </p>
          <div class="flex flex-wrap gap-2">
            {#each components as component (component)}<Badge tone="amber">{component}</Badge>{/each}
          </div>
        </div>
        <Alert tone="warning"
          >Plugins can execute code with the harness's permissions. Review the manifests, hooks, MCP server definitions
          and scripts below before enabling this exact version.</Alert
        >
        {#if controller.previous && !controller.candidate.unavailableReason && controller.candidate.artifact?.checksum !== controller.previous.assignment?.artifact?.checksum}
          <Checkbox
            name="plugin-use-latest"
            label="Apply the marketplace update"
            description="Compare the approved files with the new candidate. A fresh confirmation is required."
            bind:checked={
              () => controller.latest,
              (value) => {
                controller.latest = value;
                controller.confirmed = false;
              }
            }
          />
        {/if}
        <SkillSourceFiles
          {artifact}
          before={controller.latest ? controller.previous?.assignment?.artifact : undefined}
        />
      {:else if current === 1}
        <Field label="Library name"><Input name="plugin-name" required maxlength={120} bind:value={skill.name} /></Field
        >
        <SkillDestinations
          bind:skill
          workers={controller.environment.snapshot.workers}
          harnesses={pluginHarnesses(artifact.files)}
          plugin
        />
      {:else}
        <h3 class="font-medium text-balance wrap-anywhere">{skill.name}</h3>
        <p class="text-base text-muted sm:text-sm">
          Approve the reviewed files for the selected computers. New sessions load this version after sync.
        </p>
        <p class="font-mono text-base wrap-anywhere sm:text-sm">SHA-256 {artifact.checksum}</p>
        <Checkbox
          name="plugin-confirm-execution"
          label="I reviewed this version and allow its components to execute on assigned computers"
          description="This confirmation is recorded in the gateway audit with the exact checksum and commit."
          bind:checked={controller.confirmed}
        />
        {#if controller.revision !== controller.environment.snapshot.revision}<Alert tone="warning"
            >The environment changed while you were editing. Reopen this plugin to review the current assignment.</Alert
          >{/if}
      {/if}
    {/if}
  {/snippet}
</EnvironmentSheet>
