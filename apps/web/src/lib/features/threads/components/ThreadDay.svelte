<script lang="ts">
  import type { Timestamp } from "@bufbuild/protobuf/wkt";
  import { formatDay, isoDateTime } from "#lib/shared/format.ts";

  let { at }: { at: Timestamp } = $props();
</script>

<p class="flex justify-center pb-2">
  <time
    datetime={isoDateTime(at)}
    class="rounded-full bg-zinc-950/5 px-2.5 py-0.5 text-sm/5 font-medium text-zinc-600 sm:text-xs/5 dark:bg-white/8 dark:text-zinc-400"
    >{formatDay(at)}</time
  >
</p>
