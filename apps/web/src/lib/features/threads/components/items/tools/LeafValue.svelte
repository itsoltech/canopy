<script lang="ts">
  import { formatDateTime } from "#lib/shared/format.ts";
  import RequestText from "#lib/shared/ui/RequestText.svelte";
  import ExternalLink from "#lib/shared/ui/ExternalLink.svelte";
  import { timestampFromDate } from "@bufbuild/protobuf/wkt";
  import type { Node } from "#lib/shared/structure.ts";
  import { shortUrl } from "@canopy/domain/tools";
  import IdValue from "./IdValue.svelte";

  /** One value of a structured view, as people read it (structure.ts kinds); lists and objects are StructuredView's. */
  let { node }: { node: Node } = $props();
</script>

{#if node.kind === "text"}
  <span class="break-words">{node.text}</span>
{:else if node.kind === "long"}
  <RequestText text={node.text} />
{:else if node.kind === "number"}
  <span class="tabular-nums">{node.text}</span>
{:else if node.kind === "bool"}
  {node.value ? "Yes" : "No"}
{:else if node.kind === "date"}
  <time datetime={node.iso} title={node.iso}>{formatDateTime(timestampFromDate(new Date(node.iso)))}</time>
{:else if node.kind === "enum"}
  <span title={node.raw}>{node.label}</span>
{:else if node.kind === "id"}
  <IdValue id={node.id} />
{:else if node.kind === "url"}
  <ExternalLink href={node.href} title={node.href} class="break-all">{shortUrl(node.href)}</ExternalLink>
{:else if node.kind === "path"}
  <code class="font-mono wrap-anywhere text-zinc-800 dark:text-zinc-200" title={node.path}>{node.path}</code>
{:else if node.kind === "empty"}
  <span class="text-zinc-400 dark:text-zinc-500">None</span>
{/if}
