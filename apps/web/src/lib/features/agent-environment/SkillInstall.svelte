<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { untrack } from "svelte";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import AssignmentEditor from "./AssignmentEditor.svelte";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import { encode } from "#lib/shared/wire.ts";

  let {
    ids = $bindable([]),
    environment,
    class: className,
  }: {
    ids: string[];
    environment: EnvironmentState;
    class?: ClassValue;
  } = $props();

  let selector = $state(create(ui.EnvironmentSelectorSchema, { everyone: true }));
  let revision = $state(0n);
  let busy = $state(false);
  let completed = $state(0);

  $effect(() => {
    if (ids.length) {
      selector = create(ui.EnvironmentSelectorSchema, { everyone: true });
      revision = untrack(() => environment.snapshot.revision);
      completed = 0;
    }
  });

  async function install() {
    busy = true;
    const batch = [...ids];

    for (const id of batch.slice(completed)) {
      const skill = environment.snapshot.skills.find((s) => s.id === id);

      if (!skill) break;

      const request = create(ui.SaveLibrarySkillRequestSchema, {
        skill: { ...skill, artifact: undefined, selector },
        expectedRevision: revision,
      });

      const saved = await environment.mutate("POST", "/skills", encode(ui.SaveLibrarySkillRequestSchema, request));

      if (!saved) break;
      revision = saved.revision;
      completed++;
    }

    busy = false;

    if (completed === batch.length) {
      ids = [];
      environment.notice = `${batch.length === 1 ? "Skill" : "Skills"} assigned. Computers install them when they next sync.`;
    }
  }
</script>

<EnvironmentSheet
  title={`Install ${ids.length} ${ids.length === 1 ? "skill" : "skills"}`}
  steps={["Choose computers"]}
  {busy}
  error={environment.error}
  submitLabel="Install"
  submitDisabled={revision !== environment.snapshot.revision}
  onsave={install}
  class={className}
  bind:open={
    () => ids.length > 0,
    (open) => {
      if (!open) ids = [];
    }
  }
>
  {#snippet children()}
    <p class="text-base text-muted sm:text-sm">
      Assign these skills to all computers, specific computers or tags. Existing computer overrides stay in place.
    </p>
    <AssignmentEditor bind:selector workers={environment.snapshot.workers} />
    {#if completed}<p role="status" class="text-base sm:text-sm">
        {completed} of {ids.length} saved. Retry to install the remaining skills.
      </p>{/if}
    {#if revision !== environment.snapshot.revision}<p class="text-base text-muted sm:text-sm">
        The library changed. Close and reopen this picker before installing.
      </p>{/if}
  {/snippet}
</EnvironmentSheet>
