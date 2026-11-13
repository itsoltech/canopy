<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";

  let {
    target,
    children,
    onreplace,
  }: {
    target?: WorkspaceModuleTarget;
    children: Snippet<[WorkspaceModuleTarget | undefined]>;
    onreplace: () => void;
  } = $props();

  let shown = $state(untrack(() => target));
  let root = $state<HTMLDivElement>();

  $effect(() => {
    const next = target;
    const previous = untrack(() => shown);

    if (next?.module === previous?.module && next?.resource === previous?.resource) return;

    if (root?.contains(document.activeElement)) onreplace();

    // Start loading immediately. The incoming surface fades with motion tokens in CSS;
    // an outgoing animation must not delay a file RPC or its loading state.
    shown = next;
  });
</script>

<div
  bind:this={root}
  class="t-workspace-surface min-h-0 flex-1 overflow-auto p-1 focus-ring"
  data-workspace-summary={shown ? undefined : ""}
  tabindex="-1"
>
  {#key shown?.module ?? "summary"}{@render children(shown)}{/key}
</div>
