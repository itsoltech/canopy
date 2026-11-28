<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";
  import type { ClassValue } from "svelte/elements";
  import { duration } from "#lib/shared/ui/motion.ts";

  let {
    id,
    expanded = $bindable(),
    class: className,
    children,
  }: { id: string; expanded: boolean; class?: ClassValue; children: Snippet } = $props();

  let hidden = $state(untrack(() => !expanded));

  $effect(() => {
    if (expanded || motionPreferences.reduced) {
      hidden = !expanded;

      return;
    }

    // Paint the closing row before handing its content back to browser find.
    const timer = setTimeout(() => (hidden = true), duration("fast"));

    return () => clearTimeout(timer);
  });
</script>

<div class="t-acc-panel grid-cols-1" data-open={expanded || undefined}>
  <div
    {id}
    class={className}
    hidden={hidden ? "until-found" : undefined}
    inert={!expanded && !hidden}
    onbeforematch={() => (expanded = true)}
  >
    {@render children()}
  </div>
</div>
