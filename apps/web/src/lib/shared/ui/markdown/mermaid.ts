import type { VisualTheme } from "@canopy/domain/visuals";
import { mermaidAppearance } from "./mermaid-theme.ts";
import { loadMermaid } from "#lib/shared/ui/markdown/mermaid-loader.ts";

let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

/** True for a fence whose info string names Mermaid (` ```mermaid `). */
export const isMermaidFence = (lang: string | undefined) => lang?.trim().toLowerCase() === "mermaid";

/**
 * Renders a Mermaid diagram to SVG in Canopy's colours. Mermaid holds one global config, so renders run one at a
 * time, each configured for its theme. `strict` sanitises labels and disables click handlers and scripts.
 */
export function renderMermaid(code: string, theme: VisualTheme): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      ...mermaidAppearance(theme),
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
    });
    sequence += 1;
    const { svg } = await mermaid.render(`canopy-mermaid-${sequence}`, code);

    return svg;
  });

  queue = run.catch(() => undefined);

  return run;
}
