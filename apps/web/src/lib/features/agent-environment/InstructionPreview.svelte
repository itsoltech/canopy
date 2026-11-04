<script lang="ts">
  import { create, toJson } from "@bufbuild/protobuf";
  import { ui, type EnvironmentInstruction } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import InstructionText from "./InstructionText.svelte";

  let {
    worker,
    draft,
    class: className,
  }: { worker: ui.EnvironmentWorker; draft?: ui.InstructionDocument | undefined; class?: ClassValue } = $props();

  let harness = $state("claude");
  let scope = $state("platform");
  let instructions = $state.raw<EnvironmentInstruction[]>([]);
  let error = $state("");
  let loading = $state(false);

  const current = $derived(
    instructions.find((i) => i.harness === harness && (scope === "device" ? i.deviceHome : i.platformHome)),
  );

  $effect(() => {
    const body = toJson(
      ui.PreviewAgentEnvironmentRequestSchema,
      create(ui.PreviewAgentEnvironmentRequestSchema, { workerId: worker.workerId, ...(draft && { draft }) }),
    );

    instructions = worker.preview;
    error = "";

    if (!draft) {
      loading = false;

      return;
    }

    loading = true;
    let active = true;

    const timer = setTimeout(() => {
      void requestJson("POST", "/api/agent-environment/preview", body)
        .then((result) => {
          if (active) instructions = decode(ui.PreviewAgentEnvironmentResponseSchema, result).instructions;
        })
        .catch((cause: Error) => {
          if (active) error = cause.message;
        })
        .finally(() => {
          if (active) loading = false;
        });
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  });
</script>

<section id="environment-preview" aria-label="Instruction preview" class={["grid min-w-0 gap-4", className]}>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-base font-semibold text-balance">Live preview</h3>
    <Badge>{draft ? "Unsaved draft" : "Saved library"}</Badge>
  </div>
  <div class="grid gap-3 sm:grid-cols-2">
    <Field label="Agent file"
      ><Select
        name="preview-harness"
        bind:value={harness}
        options={[
          { value: "claude", label: "CLAUDE.md" },
          { value: "codex", label: "AGENTS.md" },
        ]}
      /></Field
    >
    <Field label="Destination"
      ><Select
        name="preview-destination"
        bind:value={scope}
        options={[
          { value: "platform", label: "Canopy sessions" },
          { value: "device", label: "Device CLI" },
        ]}
      /></Field
    >
  </div>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="grid min-w-0 gap-2" aria-busy={loading}>
    <InstructionText
      class="max-h-96 min-h-32"
      content={current?.content ?? ""}
      empty="No instructions assigned to this destination."
    />
    <p class="text-base text-pretty text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400">
      {loading
        ? "Updating preview…"
        : `${new TextEncoder().encode(current?.content ?? "").length.toLocaleString()} / 24,576 bytes`} · Local text outside
      Canopy's block stays on the computer.
    </p>
  </div>
</section>
