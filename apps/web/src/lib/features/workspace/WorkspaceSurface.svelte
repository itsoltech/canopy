<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { prefersReducedMotion } from "svelte/motion";
  import type { WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
  import { duration } from "#lib/shared/ui/motion.ts";

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
  let leaving = $state(false);
  let root = $state<HTMLDivElement>();

  $effect(() => {
    const next = target;
    const previous = untrack(() => shown);

    if (next?.module === previous?.module && next?.resource === previous?.resource) return;

    if (root?.contains(document.activeElement)) onreplace();

    const replace = () => {
      shown = next;
      leaving = false;
    };

    if (prefersReducedMotion.current) {
      replace();

      return;
    }

    leaving = true;
    const timer = setTimeout(replace, duration("quick"));

    return () => {
      clearTimeout(timer);
      leaving = false;
    };
  });
</script>

<div
  bind:this={root}
  class="t-workspace-surface min-h-0 flex-1 overflow-auto p-1 focus-ring"
  data-leaving={leaving || undefined}
  data-workspace-summary={shown ? undefined : ""}
  tabindex="-1"
  inert={leaving}
>
  {#key shown?.module ?? "summary"}{@render children(shown)}{/key}
</div>
