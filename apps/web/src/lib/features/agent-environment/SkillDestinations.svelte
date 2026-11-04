<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import AssignmentEditor from "./AssignmentEditor.svelte";

  let {
    skill = $bindable(),
    workers,
    class: className,
  }: { skill: ui.LibrarySkill; workers: readonly ui.EnvironmentWorker[]; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 gap-5", className]}>
  <div class="flex flex-wrap gap-4" aria-label="Skill harnesses">
    {#each ["claude", "codex", "grok"] as harness (harness)}
      <Checkbox
        name="skill-{harness}"
        label={harness === "claude" ? "Claude" : harness === "codex" ? "Codex" : "Grok"}
        bind:checked={
          () => skill.harnesses.includes(harness),
          (checked) =>
            (skill.harnesses = checked ? [...skill.harnesses, harness] : skill.harnesses.filter((h) => h !== harness))
        }
      />
    {/each}
  </div>
  <Checkbox
    name="skill-platform-home"
    label="Canopy agent sessions"
    description="Every isolated home for the selected harnesses."
    bind:checked={skill.platformHome}
  />
  <Checkbox
    name="skill-device-home"
    label="Device CLI too"
    description="Includes ~/.agents/skills for Codex. Other compatible harnesses may discover these user skills."
    bind:checked={skill.deviceHome}
  />
  {#if skill.selector}<AssignmentEditor
      bind:selector={skill.selector}
      {workers}
      disabled={skill.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
    />{/if}
</div>
