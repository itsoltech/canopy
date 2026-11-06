<script lang="ts">
  import { str } from "#lib/shared/json.ts";
  import ChecklistSteps from "../ChecklistSteps.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { todos } from "@canopy/domain/tools";
  import ResultText from "./ResultText.svelte";

  /** TodoWrite and Codex update_plan: the list as a checklist (done, in progress, to do) and its note. */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const steps = $derived(todos(input));
  const note = $derived(str(input["explanation"]));
</script>

{#if note}<p class="text-base/6 text-pretty text-zinc-700 sm:text-sm/6 dark:text-zinc-300">{note}</p>{/if}
{#if steps.length > 0}<ChecklistSteps {steps} />{/if}
{#if call.isError || steps.length === 0}<ResultText {call} {status} {streaming} />{/if}
