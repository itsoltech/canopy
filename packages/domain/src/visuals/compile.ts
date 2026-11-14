import { VISUAL_KIT_VERSION, VISUAL_LIMITS, VISUAL_PROTOCOL_VERSION } from "./limits.ts";
import type { VisualDocumentData } from "./protocol.ts";
import type { DecodedVisual } from "./spec.ts";
import { utf8Bytes } from "./spec.ts";
import { validVisualTheme, type VisualTheme } from "./theme-tokens.ts";
import type { VisualState } from "./types.ts";
import { validVisualState } from "./semantics.ts";
import { KIT_DEFAULT_TOKENS, KIT_SCRIPT, KIT_STYLE } from "./gen/kit.ts";

export { KIT_SCRIPT_CSP } from "./gen/kit.ts";

export interface CompileOptions {
  readonly title: string;
  /** frame: a host connects a port after mounting. export: a standalone file. */
  readonly mode: "frame" | "export";
  /** Random per mount; only the kit's own script and styles carry it. */
  readonly nonce: string;
  readonly instance: string;
  readonly theme?: VisualTheme;
  /** Cached local state to restore; dropped unless it fits the spec. */
  readonly state?: VisualState;
  readonly reducedMotion?: boolean;
}

export class VisualCompileError extends Error {}

const NONCE = /^[A-Za-z0-9+/_-]{16,64}={0,2}$/;

/** Policy of every compiled document: nothing loads, submits, navigates or embeds; only the nonced kit runs. */
export function visualPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    `style-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const HTML_ESCAPES = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES.get(char) ?? char);
}

/** JSON safe inside a <script type="application/json"> block: no tag, comment or line-terminator sequences. */
export function inertJson(value: VisualDocumentData): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * Compiles a validated spec into one self-contained HTML document with the pinned kit. Model text never becomes
 * markup: the title is escaped, the spec travels as inert JSON and the kit renders it with textContent.
 */
export function compileVisual(visual: DecodedVisual, options: CompileOptions): string {
  if (!NONCE.test(options.nonce) || !/^[A-Za-z0-9-]{1,64}$/.test(options.instance))
    throw new VisualCompileError("invalid mount identifiers");

  if (options.theme && !validVisualTheme(options.theme)) throw new VisualCompileError("invalid theme");
  const restored = options.state && validVisualState(visual.domains, options.state) ? options.state : {};

  const data: VisualDocumentData = {
    protocol: VISUAL_PROTOCOL_VERSION,
    mode: options.mode,
    instance: options.instance,
    nonce: options.nonce,
    spec: visual.spec,
    domains: [...visual.domains],
    state: restored,
    theme: options.theme ?? null,
    reducedMotion: options.reducedMotion ?? false,
  };

  const nonce = options.nonce;

  const html = [
    "<!doctype html>",
    `<html lang="en" data-kit="${VISUAL_KIT_VERSION}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${visualPolicy(nonce)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style nonce="${nonce}">${KIT_STYLE}${KIT_DEFAULT_TOKENS}</style>`,
    "</head>",
    "<body>",
    `<script type="application/json" id="canopy-visual-data">${inertJson(data)}</script>`,
    `<script nonce="${nonce}">${KIT_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("");

  if (utf8Bytes(html) > VISUAL_LIMITS.htmlBytes) throw new VisualCompileError("the compiled visual is too large");

  return html;
}

/** A random nonce or instance id for one mount. */
export function visualToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
