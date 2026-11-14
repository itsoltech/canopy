import { Result } from "effect";
import type { JsonObject } from "../json.ts";
import { compileVisual, escapeHtml, inertJson } from "./compile.ts";
import { SHELL_MESSAGE_CHARS } from "./host.ts";
import { REVOKED_VISUAL_KITS, VISUAL_KIT_VERSION, VISUAL_LIMITS } from "./limits.ts";
import { connectMessage } from "./protocol.ts";
import { parseVisualSpec } from "./spec.ts";
import type { VisualTheme } from "./theme-tokens.ts";
import type { VisualState, VisualStateDomain } from "./types.ts";

export interface ShellOptions {
  readonly title: string;
  /** The compiled visual (`compileVisual` in frame mode): it runs in the sandboxed iframe, never in the shell. */
  readonly html: string;
  /**
   * The nonce the visual was compiled with. A srcdoc frame inherits the shell's policy on top of its own, so both
   * documents allow the same nonce; the handshake checks it too.
   */
  readonly nonce: string;
  /** The `instance` the visual was compiled with. */
  readonly instance: string;
  /** Random per mount; marks the messages the shell relays to the app. The iframe never sees it. */
  readonly token: string;
}

/** The shell loads nothing either: only its nonced script and style run, and the srcdoc frame is its one child. */
export function shellPolicy(nonce: string): string {
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
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const SHELL_STYLE =
  "html,body{margin:0;height:100%;overflow:hidden;background:transparent}" +
  "iframe{display:block;width:100%;height:100%;border:0;background:transparent}";

/**
 * The shell's whole program. It never evaluates data: the iframe gets the compiled document as `srcdoc`, the native
 * side gets the iframe's port messages as strings in a token envelope, and host messages are accepted only from the
 * native side (no `source`) with the same token. Dialogs and new windows are disabled before anything else runs.
 */
const SHELL_SCRIPT = `(function () {
  "use strict";
  var bridge = window.ReactNativeWebView;
  var data = JSON.parse(document.getElementById("canopy-shell-data").textContent);
  var none = function () { return null; };
  window.open = none; window.alert = none; window.confirm = none; window.prompt = none;
  if (!bridge || typeof bridge.postMessage !== "function") return;
  var post = bridge.postMessage.bind(bridge);
  var channel = new MessageChannel();
  var connected = false;
  var windowStart = 0;
  var count = 0;
  var send = function (message) {
    var text;
    try { text = JSON.stringify({ canopy_shell: data.token, message: message }); } catch (error) { return; }
    if (typeof text === "string" && text.length <= ${SHELL_MESSAGE_CHARS}) post(text);
  };
  channel.port1.onmessage = function (event) {
    var now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; count = 0; }
    if (++count > ${VISUAL_LIMITS.messagesPerSecond * 2}) return;
    send(event.data);
  };
  var frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  frame.title = data.title;
  frame.addEventListener("load", function () {
    if (connected || !frame.contentWindow) return;
    connected = true;
    frame.contentWindow.postMessage(data.connect, "*", [channel.port2]);
  });
  var onHost = function (event) {
    if (event.source || typeof event.data !== "string" || event.data.length > ${SHELL_MESSAGE_CHARS}) return;
    var envelope;
    try { envelope = JSON.parse(event.data); } catch (error) { return; }
    if (!envelope || envelope.canopy_shell !== data.token) return;
    channel.port1.postMessage(envelope.message);
  };
  window.addEventListener("message", onHost);
  document.addEventListener("message", onHost);
  frame.srcdoc = data.html;
  document.body.appendChild(frame);
})();`;

/**
 * The document a mobile WebView loads (docs/agent-visuals.md §4): a trusted shell around one sandboxed iframe with
 * the same compiled visual and CSP as the web. Only the shell can reach the app; the visual talks to the shell over
 * the port protocol and nothing else.
 */
export function compileVisualShell(options: ShellOptions): string {
  const data: JsonObject = {
    title: options.title,
    token: options.token,
    html: options.html,
    connect: connectMessage(options.instance, options.nonce),
  };

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${shellPolicy(options.nonce)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style nonce="${options.nonce}">${SHELL_STYLE}</style>`,
    "</head>",
    "<body>",
    `<script type="application/json" id="canopy-shell-data">${inertJson(data)}</script>`,
    `<script nonce="${options.nonce}">${SHELL_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("");
}

export interface ShellMount {
  readonly kind: "ready";
  readonly html: string;
  readonly token: string;
  readonly domains: ReadonlyMap<string, VisualStateDomain>;
}

export type ShellMountResult = ShellMount | { readonly kind: "update" } | { readonly kind: "invalid" };

/**
 * Everything a mobile host needs for one mount: the stored spec parsed again, compiled in frame mode and wrapped in
 * the shell, with a fresh nonce, instance and token from `random` (a URL-safe token of at least 16 characters).
 * `update`: the visual needs a newer or fixed kit. `invalid`: the spec doesn't parse.
 */
export function mountVisualShell(
  specJson: string,
  options: {
    readonly title: string;
    readonly kitVersion: number;
    readonly theme: VisualTheme;
    readonly reducedMotion: boolean;
    readonly state: VisualState | undefined;
    readonly random: () => string;
  },
): ShellMountResult {
  if (options.kitVersion > VISUAL_KIT_VERSION || REVOKED_VISUAL_KITS.has(options.kitVersion)) return { kind: "update" };
  const decoded = parseVisualSpec(specJson);

  if (Result.isFailure(decoded)) return { kind: "invalid" };
  const nonce = options.random();

  const instance = options
    .random()
    .replace(/[^A-Za-z0-9-]/g, "")
    .slice(0, 64);

  const token = options.random();

  const html = compileVisual(decoded.success, {
    title: options.title,
    mode: "frame",
    nonce,
    instance,
    theme: options.theme,
    reducedMotion: options.reducedMotion,
    ...(options.state && { state: options.state }),
  });

  return {
    kind: "ready",
    html: compileVisualShell({ title: options.title, html, nonce, instance, token }),
    token,
    domains: decoded.success.domains,
  };
}
