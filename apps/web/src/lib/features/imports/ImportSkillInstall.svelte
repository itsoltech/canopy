<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { sharedEnvironment } from "#lib/features/agent-environment/environment-state.svelte.ts";
  import AssignmentEditor from "#lib/features/agent-environment/AssignmentEditor.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import type { ImportLibraryState } from "./import-library.svelte.ts";

  let { library, class: className }: { library: ImportLibraryState; class?: ClassValue } = $props();
  const environment = sharedEnvironment();

  const skills = $derived(
    library.items.filter(
      (i) => ["skill", "command"].includes(i.kind) && library.isChosen(i.key) && library.actionOf(i.key) !== "replace",
    ),
  );
</script>

{#if skills.length}<div class={["grid gap-3 px-4 py-3", className]}>
    <Field label="Install these skills on">
      <Select
        name="import-skill-install"
        bind:value={library.installTarget}
        options={[
          { value: "source", label: "This computer (import source)" },
          { value: "all", label: "All computers" },
          { value: "choose", label: "Choose…" },
        ]}
      />
    </Field>
    <p class="text-base text-pretty text-muted sm:text-sm">
      New skills install in Canopy sessions after import. Existing skill assignments stay the same.
    </p>
    {#if library.installTarget === "choose"}<AssignmentEditor
        bind:selector={library.selector}
        workers={environment.data?.workers ?? []}
      />{/if}
  </div>{/if}
