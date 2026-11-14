import { compileHtml, visualToken } from "@canopy/domain/visual-compiler";
import { compileVisualShell } from "@canopy/domain/visual-shell";
import { currentVisualTheme } from "./visual-theme.ts";

/** The trusted parent policy also prevents the untrusted child navigating itself. */
export function htmlFrameDocument(specJson: string, title: string, nonce: string, instance: string): string {
  const compiled = compileHtml(specJson, { nonce, instance, theme: currentVisualTheme() });

  return compileVisualShell({
    title,
    nonce,
    instance,
    token: visualToken(),
    html: compiled.html,
    scriptHashes: compiled.hashes,
  });
}
