<script lang="ts">
  import { humanizeKey } from "#lib/shared/humanize.ts";
  import { fieldsOf, isEmptyNode } from "#lib/shared/structure.ts";
  import LongText from "#lib/shared/ui/LongText.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { stripReminders, unwrapContent } from "./parse.ts";
  import ResultText from "./ResultText.svelte";
  import Section from "./Section.svelte";
  import StructuredView from "./StructuredView.svelte";

  /**
   * Tools whose input and result are prose (Skill, ExitPlanMode): long text arguments and the result as
   * markdown, collapsed when long; short arguments as fields.
   */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const prose = $derived(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string" && (entry[1].includes("\n") || entry[1].length > 120)));
  const rest = $derived({ kind: "object" as const, fields: fieldsOf(input).filter((f) => !prose.some(([key]) => key === f.key) && !isEmptyNode(f.node)) });
  const result = $derived(stripReminders(unwrapContent(call.output)).trim());
</script>

{#if rest.fields.length > 0}<StructuredView node={rest} />{/if}
{#each prose as [key, text] (key)}
  <Section label={humanizeKey(key)}><LongText {text} markdown lines={10} /></Section>
{/each}
{#if result && !call.isError && !streaming}
  <Section label="Result"><LongText text={result} markdown lines={8} /></Section>
{:else if call.isError || streaming}
  <ResultText {call} {status} {streaming} />
{/if}
