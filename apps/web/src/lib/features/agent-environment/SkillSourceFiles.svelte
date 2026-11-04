<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { SkillArtifact, SkillFile } from "@canopy/contracts";
  import { skillChanges, skillScript } from "@canopy/domain/skill-source";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import InstructionText from "./InstructionText.svelte";
  import VersionComparison from "./VersionComparison.svelte";

  let {
    artifact,
    before,
    class: className,
  }: { artifact: SkillArtifact; before?: SkillArtifact; class?: ClassValue } = $props();

  let path = $state("SKILL.md");

  const changes = $derived(
    before
      ? skillChanges(before, artifact)
      : artifact.files.map((f) => ({ path: f.path, kind: "added", script: skillScript(f) })),
  );

  const paths = $derived([...new Set([...artifact.files, ...(before?.files ?? [])].map((f) => f.path))].sort());

  $effect(() => {
    if (!paths.includes(path)) path = paths[0] ?? "";
  });

  function text(files: readonly SkillFile[] = []): string {
    const file = files.find((f) => f.path === path);

    if (!file) return "(File absent)";

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(file.content);
    } catch {
      return `(Binary file · ${file.content.length} bytes · SHA-256 ${file.checksum})`;
    }
  }
</script>

<div class={["@container grid min-w-0 gap-3", className]}>
  <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">{artifact.description}</p>
  <ul
    role="list"
    class="max-h-48 overflow-auto rounded-lg bg-zinc-950/3 p-3 text-base sm:text-sm dark:bg-white/4"
    aria-label="Source file changes"
  >
    {#each changes as change (change.path)}
      <li class="flex flex-wrap justify-between gap-x-3 gap-y-1 py-1">
        <span class="min-w-0 font-mono wrap-anywhere">{change.path}</span>
        <span
          class={change.script ? "font-medium text-amber-700 dark:text-amber-300" : "text-zinc-500 dark:text-zinc-400"}
          >{change.kind}{change.script ? " · Script / executable" : ""}</span
        >
      </li>
    {:else}<li>No file changes. Only the upstream commit changed.</li>{/each}
  </ul>
  <Field label={before ? "Compare source file" : "Inspect source file"}>
    <Select name="source-file" bind:value={path} options={paths.map((value) => ({ value, label: value }))} />
  </Field>
  {#if before}<VersionComparison
      local={text(before.files)}
      expected={text(artifact.files)}
      localLabel="Current version"
      expectedLabel="Upstream candidate"
    />
  {:else}<InstructionText class="max-h-64" content={text(artifact.files)} />{/if}
</div>
