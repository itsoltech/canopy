<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { pluginComponents, pluginHarnesses } from "@canopy/domain/plugin-components";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import SkillDestinations from "./SkillDestinations.svelte";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";
  import type { PluginState } from "./plugin-state.svelte.ts";

  let {
    state,
    skill = $bindable(),
    class: className,
  }: { state: PluginState; skill: ui.LibrarySkill; class?: ClassValue } = $props();

  const artifact = $derived(state.latest ? state.candidate?.artifact : state.previous?.assignment?.artifact);
  const components = $derived(artifact ? pluginComponents(artifact.files) : []);
</script>

{#if state.draft && state.marketplace && state.candidate && artifact}
  <section
    class={["@container grid min-w-0 gap-5 rounded-xl border border-zinc-950/10 p-4 dark:border-white/10", className]}
    aria-label="Review and enable plugin"
  >
    <div class="grid min-w-0 gap-2">
      <h3 class="text-base font-semibold text-balance">Review {artifact.name}@{state.marketplace.name}</h3>
      <p class="font-mono text-base wrap-anywhere sm:text-sm">
        Commit {state.latest ? state.marketplace.source?.commit : state.previous?.commit}
      </p>
      <div class="flex flex-wrap gap-2">
        {#each components as component (component)}<Badge tone="amber">{component}</Badge>{/each}
      </div>
    </div>
    <Alert tone="warning"
      >Plugins can execute code with the harness's permissions. Review the manifests, hooks, MCP server definitions and
      scripts below before enabling this exact version.</Alert
    >
    {#if state.previous && !state.candidate.unavailableReason && state.candidate.artifact?.checksum !== state.previous.assignment?.artifact?.checksum}
      <Checkbox
        name="plugin-use-latest"
        label="Apply the marketplace update"
        description="Compare the approved files with the new candidate. A fresh confirmation is required."
        bind:checked={
          () => state.latest,
          (value) => {
            state.latest = value;
            state.confirmed = false;
          }
        }
      />
    {/if}
    <SkillSourceFiles {artifact} before={state.latest ? state.previous?.assignment?.artifact : undefined} />
    <Field label="Library name"><Input name="plugin-name" bind:value={skill.name} /></Field>
    <SkillDestinations
      bind:skill
      workers={state.environment.snapshot.workers}
      harnesses={pluginHarnesses(artifact.files)}
      plugin
    />
    <p class="font-mono text-base wrap-anywhere sm:text-sm">SHA-256 {artifact.checksum}</p>
    <Checkbox
      name="plugin-confirm-execution"
      label="I reviewed this version and allow its components to execute on assigned computers"
      description="This confirmation is recorded in the gateway audit with the exact checksum and commit."
      bind:checked={state.confirmed}
    />
    {#if state.revision !== state.environment.snapshot.revision}<Alert tone="warning"
        >The environment changed while you were editing. Reopen this plugin to review the current assignment.</Alert
      >{/if}
    <div class="flex flex-wrap gap-2">
      <Button
        disabled={!state.confirmed || state.environment.busy || state.revision !== state.environment.snapshot.revision}
        onclick={() => state.savePlugin()}>Approve and sync plugin</Button
      >
      <Button variant="ghost" disabled={state.environment.busy} onclick={() => (state.draft = undefined)}>Cancel</Button
      >
    </div>
  </section>
{/if}
