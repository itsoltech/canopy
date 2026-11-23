<script lang="ts">
  import WorkspaceMarkdown from "../WorkspaceMarkdown.svelte";
  import { provideFileLinks } from "#lib/shared/ui/markdown/file-links.ts";
  import { provideClipboard } from "#lib/shared/ui/clipboard-context.ts";
  import { request } from "./bridge.ts";

  let { text, path }: { text: string; path: string } = $props();

  provideFileLinks({
    open: (path) => void request("file", path).catch(() => undefined),
    copyPath: (path, kind) =>
      void request(kind === "full" ? "copy-full-path" : "copy-relative-path", path).catch(() => undefined),
    canDownload: false,
    download: () => undefined,
  });
  provideClipboard(async (text) => {
    await request("copy", text);
  });
</script>

<WorkspaceMarkdown {text} {path} loadImage={(_path, href) => request("image", href)} />
