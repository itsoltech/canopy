<script lang="ts">
  import { fieldsOf, isEmptyNode } from "#lib/shared/structure.ts";
  import type { ToolBodyProps } from "./body.ts";
  import ResultText from "./ResultText.svelte";
  import Section from "./Section.svelte";
  import StructuredView from "./StructuredView.svelte";

  /** Any tool without its own view (MCP tools, new tools): the input as labelled fields, then the result. */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const node = $derived({ kind: "object" as const, fields: fieldsOf(input).filter((f) => !isEmptyNode(f.node)) });
</script>

{#if node.fields.length > 0}
  <Section label="Input"><StructuredView {node} /></Section>
{/if}
<Section label="Result"><ResultText {call} {status} {streaming} /></Section>
