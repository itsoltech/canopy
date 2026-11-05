<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";
  import { encode } from "#lib/shared/wire.ts";
  import TagInput from "#lib/shared/ui/TagInput.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import type { LinkedWorker } from "./worker-records.svelte.ts";

  let {
    worker,
    environment,
    linked,
    onchanged,
    class: className,
  }: {
    worker: ui.Worker;
    environment: EnvironmentState;
    /** Another computer's worker: tags from its home's record, saved at its home. */
    linked?: LinkedWorker;
    onchanged?: () => void;
    class?: ClassValue;
  } = $props();

  const saved = $derived(
    linked
      ? { manualTags: linked.record.manualTags, automaticTags: linked.record.automaticTags }
      : environment.snapshot.workers.find((w) => w.workerId === worker.id),
  );

  let sending = $state(false);
  let failure = $state("");
  const busy = $derived(environment.busy || sending);
  const key = (tags: readonly string[]) => JSON.stringify([...tags].sort());
  let tags = $state<string[]>([]);
  let previous = $state("[]");
  let conflict = $state(false);
  let notice = $state("");
  const dirty = $derived(key(tags) !== previous);

  $effect(() => {
    const current = key(saved?.manualTags ?? []);

    if (current === untrack(() => previous)) return;

    if (untrack(() => !dirty || key(tags) === current)) {
      tags = [...(saved?.manualTags ?? [])];
      previous = current;
      conflict = false;
    } else conflict = true;
  });

  function reload() {
    tags = [...(saved?.manualTags ?? [])];
    previous = key(tags);
    conflict = false;
    notice = "";
  }

  async function save() {
    notice = "";
    failure = "";

    const body = create(ui.SetEnvironmentTagsRequestSchema, {
      workerId: worker.id,
      tags,
      expectedRevision: linked ? 0n : environment.snapshot.revision,
    });

    if (linked) {
      // The home answers with its own library; this computer's stays as it is.
      sending = true;

      try {
        await requestJson("POST", "/api/agent-environment/tags", encode(ui.SetEnvironmentTagsRequestSchema, body));
        previous = key(tags);
        notice = "Tags saved. Assignments will sync, including when this worker reconnects.";
        onchanged?.();
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : "Could not save tags. Try again.";
      } finally {
        sending = false;
      }

      return;
    }

    if (await environment.mutate("POST", "/tags", encode(ui.SetEnvironmentTagsRequestSchema, body))) {
      reload();
      notice = "Tags saved. Assignments will sync, including when this worker reconnects.";
    }
  }
</script>

<section class={["grid min-w-0 gap-3", className]} aria-label={`Tags for ${worker.name}`}>
  <h3 class="text-base/6 font-semibold sm:text-sm/6">Worker tags</h3>
  {#if worker.nodeId && !linked}
    <Alert>Edit tags in Workers on this worker's home computer.</Alert>
  {:else if saved}
    <div class="grid gap-2">
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Detected automatically · read-only</p>
      <div class="flex flex-wrap gap-1.5" aria-label="Automatic worker tags">
        {#each saved.automaticTags as tag (tag)}<Badge class="max-w-full break-all whitespace-normal">{tag}</Badge>
        {:else}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            Detected when this worker connects.
          </p>{/each}
      </div>
    </div>
    <fieldset class="grid min-w-0 gap-3" disabled={busy || Boolean(linked?.readOnly)}>
      <TagInput
        label="Manual tags"
        name={`worker-tags-${worker.id}`}
        bind:value={tags}
        workers={environment.snapshot.workers}
        automatic={false}
        description="Groups for instruction, skill and plugin assignments. Use up to 32 tags."
      />
      {#if conflict}
        <Alert tone="warning">This worker's tags changed elsewhere. Reload saved tags before editing again.</Alert>
      {/if}
      <div class="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={busy}
          disabled={!dirty || conflict || Boolean(linked?.readOnly)}
          onclick={() => void save()}>Save tags</Button
        >
        {#if dirty || conflict}<Button size="sm" variant="ghost" onclick={reload}>Reload saved tags</Button>{/if}
      </div>
    </fieldset>
    {#if failure}<Alert tone="error">{failure}</Alert>{/if}
    {#if notice}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">{notice}</p>{/if}
  {:else}
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      {worker.revokedAt
        ? "Tags are unavailable for revoked workers."
        : environment.loaded
          ? "Tags can only be edited for workers owned by you on this computer."
          : "Loading worker tags…"}
    </p>
  {/if}
</section>
