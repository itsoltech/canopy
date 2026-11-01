<script lang="ts">
  import { enhance } from "$app/forms";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * A form posting to a page action with progressive enhancement. The content gets `busy` (while it is
   * sent) and `submitted` (this form sent something: the page's `form` error belongs to it, not to
   * another form on the page). `onsuccess` runs after a successful action (close a dialog).
   */
  let {
    action,
    onsuccess,
    class: className,
    children,
  }: { action: string; onsuccess?: (() => void) | undefined; class?: ClassValue; children: Snippet<[{ busy: boolean; submitted: boolean }]> } = $props();

  let busy = $state(false);
  let submitted = $state(false);
</script>

<form
  method="POST"
  {action}
  class={className}
  use:enhance={() => {
    busy = true;
    submitted = true;
    return async ({ result, update }) => {
      await update();
      busy = false;
      if (result.type === "success") onsuccess?.();
    };
  }}
>
  {@render children({ busy, submitted })}
</form>
