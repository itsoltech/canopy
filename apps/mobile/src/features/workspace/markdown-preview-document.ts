import type { JsonObject } from "@canopy/domain/json";
import bundle from "./markdown-preview.generated.json";

/** Only the compiled renderer can run. Workspace Markdown is inert input to the allowlisted token pipeline. */
export function markdownPreviewDocument(data: JsonObject): string {
  const payload = JSON.stringify(data).replaceAll("<", "\\u003c");

  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${bundle.hash}' 'sha256-${bundle.mermaidHash}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    "<style>",
    bundle.css,
    "</style></head><body>",
    `<script id="preview-data" type="application/json">${payload}</script>`,
    `<script type="module">${bundle.js}</script>`,
    "</body></html>",
  ].join("");
}
