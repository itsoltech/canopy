<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import { toJsonString } from "@bufbuild/protobuf";
  import { ui as schemas } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";

  let { quote, children, class: className }: { quote: ui.Quote; children: Snippet; class?: ClassValue } = $props();
</script>

<div
  class={["group/pr min-w-0", className]}
  data-quote-item={quote.pullRequest?.resourceId}
  data-quote-kind="pull_request"
  data-quote-pr={toJsonString(schemas.QuoteSchema, quote)}
>
  {@render children()}
</div>
