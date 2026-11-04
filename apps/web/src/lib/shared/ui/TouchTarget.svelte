<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let { size = "md", class: className }: { size?: "sm" | "md"; class?: ClassValue } = $props();
</script>

<!-- 48px by default, 40px for dense rows. Parent must be relative; visuals keep their own size. -->
<span
  class={[
    "absolute top-1/2 left-1/2 -translate-1/2 pointer-fine:hidden",
    size === "sm" ? "size-[max(100%,2.5rem)]" : "size-[max(100%,3rem)]",
    className,
  ]}
  aria-hidden="true"
></span>
