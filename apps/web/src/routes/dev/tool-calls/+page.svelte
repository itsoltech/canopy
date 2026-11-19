<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<div class="h-full overflow-y-auto">
  <data.Gallery />
</div>
