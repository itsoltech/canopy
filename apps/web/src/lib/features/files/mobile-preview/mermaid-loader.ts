import type { Mermaid } from "mermaid";
import { request } from "./bridge.ts";

declare global {
  interface Window {
    CanopyMarkdownMermaid?: Mermaid;
  }
}

let loading: Promise<Mermaid> | undefined;

async function install() {
  const chunks: string[] = [];

  for (let index = 0; ; index++) {
    const chunk = await request("mermaid", String(index));

    if (!chunk) break;
    chunks.push(chunk);
  }

  const script = document.createElement("script");
  script.text = chunks.join("");
  document.head.append(script);
  script.remove();

  if (!window.CanopyMarkdownMermaid) throw new Error("Mermaid bundle did not load");

  return window.CanopyMarkdownMermaid;
}

// The host serves the bundled renderer. The document CSP pins its exact hash.
export const loadMermaid = () => (loading ??= install());
