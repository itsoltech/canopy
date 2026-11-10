<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Input from "#lib/shared/ui/Input.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";
  import SkillDestinations from "./SkillDestinations.svelte";
  import SourceCredentialPicker from "./SourceCredentialPicker.svelte";
  import { SourceState } from "./source-state.svelte.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";

  let {
    environment,
    open = $bindable(false),
    class: className,
  }: { environment: EnvironmentState; open?: boolean; class?: ClassValue } = $props();

  const source = new SourceState(untrack(() => environment));
  let command = $state("");
  let accountId = $state("");
  let step = $state(0);

  $effect(() => {
    if (!open) {
      step = 0;
      source.preview = undefined;
      source.error = "";
      command = "";
      accountId = "";
    }
  });
</script>

<EnvironmentSheet
  bind:open
  title="Add skills from a source"
  steps={["Command or repository", "Review skills", "Assign & confirm"]}
  bind:step
  busy={source.busy || environment.busy}
  error={source.error || environment.error}
  nextLabel={step === 0 ? "Preview source" : "Next"}
  nextDisabled={step === 0 ? !command.trim() : !source.paths.length}
  submitDisabled={!source.preview || !source.paths.length}
  class={className}
  onnext={async (current) => {
    if (current === 0) {
      await source.resolve(command, accountId);
      return Boolean(source.preview);
    }
    return Boolean(source.paths.length);
  }}
  onsave={async () => {
    await source.add();
    if (!source.preview) open = false;
  }}
>
  {#snippet children(current)}
    {#if current === 0}
      <Field
        label="Command or repository"
        description="Paste npx skills add, bunx skills add, a GitHub URL or owner/repo[/path]. Your command is parsed, never executed."
      >
        <Input
          name="skill-source-command"
          bind:value={command}
          placeholder="npx skills add vercel-labs/agent-browser"
          maxlength={4096}
          required
          disabled={source.busy || environment.busy}
          oninput={() => (source.preview = undefined)}
        />
      </Field>
      <SourceCredentialPicker
        bind:value={accountId}
        disabled={source.busy || environment.busy}
        onchange={() => (source.preview = undefined)}
      />
    {:else if source.preview}
      {#if current === 1}
        <div class="grid min-w-0 gap-4 rounded-xl p-4 ring-1 ring-zinc-950/10 dark:ring-white/10">
          <div class="grid min-w-0 gap-1">
            <h4 class="text-base font-medium text-balance">
              Review {source.preview.skills.length}
              {source.preview.skills.length === 1 ? "skill" : "skills"}
            </h4>
            <p class="font-mono text-base wrap-anywhere sm:text-sm">{source.preview.source?.url}</p>
            <p class="text-base wrap-anywhere text-zinc-500 sm:text-sm dark:text-zinc-400">
              Ref {source.preview.source?.ref} · Commit {source.preview.source?.commit}
            </p>
          </div>
          {#each source.preview.notices as notice (notice)}<p
              class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400"
            >
              {notice}
            </p>{/each}
          {#if source.preview.license.trim()}<Disclosure>
              {#snippet summary()}<span class="text-base sm:text-sm">Repository license</span>{/snippet}
              <pre
                class="max-h-48 scroll-stable overflow-auto pt-3 font-mono text-base whitespace-pre-wrap sm:text-sm">{source
                  .preview.license}</pre>
            </Disclosure>{/if}
          {#each source.preview.skills as item (item.path)}
            <div class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10">
              <Checkbox
                name="source-skill-{item.path}"
                label={item.artifact?.name ?? item.path}
                description={item.path || "Repository root"}
                disabled={environment.busy}
                bind:checked={
                  () => source.paths.includes(item.path),
                  (checked) =>
                    (source.paths = checked
                      ? [...source.paths, item.path]
                      : source.paths.filter((p) => p !== item.path))
                }
              />
              {#if item.artifact}<SkillSourceFiles artifact={item.artifact} />{/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-base text-muted sm:text-sm">
          {source.paths.length} reviewed skills will be added at commit {source.preview.source?.commit}.
        </p>
        <SkillDestinations bind:skill={source.assignment} workers={environment.snapshot.workers} />
        <Alert
          >Skills may contain executable code. Add and sync approves the selected files at this commit. Automatic
          updates start disabled.</Alert
        >
      {/if}
    {/if}
  {/snippet}
</EnvironmentSheet>
