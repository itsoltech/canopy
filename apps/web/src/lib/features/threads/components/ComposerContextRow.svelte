<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Pack location controls on wide composers; reserve paired slots when wrapped. Permission stays separate. */
  let {
    projectControl,
    computerControl,
    workspaceControl,
    branchControl,
    permissionControl,
    hasWorkspace = true,
    class: className,
  }: {
    projectControl?: Snippet;
    computerControl: Snippet;
    workspaceControl?: Snippet;
    branchControl?: Snippet;
    permissionControl: Snippet;
    hasWorkspace?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<div class={["@container/context min-w-0", className]} data-composer-context>
  <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
    <div class="grid min-w-0 items-center gap-x-1 gap-y-1 @min-[44rem]/context:flex pointer-coarse:gap-y-4">
      <div class={["grid min-w-0 items-center gap-1 @min-[44rem]/context:flex", projectControl && "grid-cols-2"]}>
        {#if projectControl}<div class="min-w-0 @min-[44rem]/context:max-w-48">{@render projectControl()}</div>{/if}
        <div class="flex min-h-8 min-w-0 items-center @min-[44rem]/context:max-w-56">{@render computerControl()}</div>
      </div>
      {#if hasWorkspace && workspaceControl}
        <div
          class="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-center gap-1 @min-[34rem]/context:grid-cols-2 @min-[44rem]/context:flex"
        >
          <div class="min-w-0 @max-[34rem]/context:max-w-28 @min-[44rem]/context:max-w-40">
            {@render workspaceControl()}
          </div>
          <div class="min-w-0 @min-[44rem]/context:max-w-56">{@render branchControl?.()}</div>
        </div>
      {/if}
    </div>
    <div class="flex min-h-8 items-center justify-end">{@render permissionControl()}</div>
  </div>
</div>
