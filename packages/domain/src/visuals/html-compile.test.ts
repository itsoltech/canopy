import { describe, expect, test } from "bun:test";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { Result } from "effect";
import { decodeAgentBusCall } from "../agent-bus/tools.ts";
import { compileHtml, htmlScriptHash } from "./html-compile.ts";
import { HTML_LOCKDOWN, HTML_NETWORK_LOCKDOWN } from "./html-lockdown.ts";
import { mountVisualShell } from "./shell.ts";
import { VisualFrameInbox, openShellEnvelope } from "./host.ts";

type CyclicFramePayload = { type: "height"; height: number; self?: CyclicFramePayload };

const options = { nonce: "test-html-nonce-123456", instance: "test-html" };
const source = (html: string) => JSON.stringify({ html });

function elements(node: DefaultTreeAdapterMap["node"]): DefaultTreeAdapterMap["element"][] {
  return [...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(elements) : [])];
}

describe("untrusted HTML boundary", () => {
  test.each([
    '<html data-x="<head>"><body data-x="</body>"><script>window.a=1</script></body></html>',
    "<!-- <head> --><html><body><!-- </body> --><script>window.a=1</script></body></html>",
  ])("inserts policy and scripts as tree nodes despite markup-like text: %s", (markup) => {
    const compiled = compileHtml(source(markup), options);
    const nodes = elements(parse(compiled.html));
    const head = nodes.find((n) => n.tagName === "head")!;
    const metas = nodes.filter((n) => n.tagName === "meta" && n.attrs.some((a) => a.name === "http-equiv"));
    expect(metas).toHaveLength(1);
    expect(head.childNodes[0]).toBe(metas[0]);
    const policy = metas[0]!.attrs.find((a) => a.name === "content")!.value;
    const scripts = nodes.filter((n) => n.tagName === "script");
    expect(scripts).toHaveLength(2);

    for (const script of scripts) {
      const code = script.childNodes.flatMap((n) => ("value" in n ? [n.value] : [])).join("");
      expect(policy).toContain(htmlScriptHash(code));
      expect(code.startsWith(HTML_LOCKDOWN)).toBe(true);
    }
  });

  test("every executable script is hash authorized and starts with lockdown", () => {
    const compiled = compileHtml(
      source(
        '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-eval\'"><button onclick="fetch(1)">Go</button><script>window.a = 1;</script><script src="https://invalid.example/a.js"></script><script type="module">import("x")</script>',
      ),
      options,
    );

    const nodes = elements(parse(compiled.html));
    const metas = nodes.filter((n) => n.tagName === "meta" && n.attrs.some((a) => a.name === "http-equiv"));
    expect(metas).toHaveLength(1);
    const policy = metas[0]!.attrs.find((a) => a.name === "content")!.value;
    const scripts = nodes.filter((n) => n.tagName === "script");
    expect(scripts).toHaveLength(2);

    for (const script of scripts) {
      const code = script.childNodes.flatMap((n) => ("value" in n ? [n.value] : [])).join("");
      expect(code.startsWith(HTML_LOCKDOWN)).toBe(true);
      expect(policy).toContain(htmlScriptHash(code));
    }

    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("unsafe-hashes");
    expect(policy.split(";").find((d) => d.trim().startsWith("script-src "))).not.toContain("unsafe-inline");

    for (const directive of [
      "default-src",
      "connect-src",
      "frame-src",
      "child-src",
      "worker-src",
      "object-src",
      "form-action",
      "base-uri",
    ])
      expect(policy).toContain(`${directive} 'none'`);
    expect(compiled.html).not.toContain("onclick=");
  });

  test("removes nested document elements and navigation attributes, including templates", () => {
    const compiled = compileHtml(
      source(
        '<iframe srcdoc="x"></iframe><object data="x"></object><embed src="x"><template><iframe></iframe></template><a href="javascript:alert(1)" ping="https://invalid.example">Link</a><base href="https://invalid.example">',
      ),
      options,
    );

    expect(compiled.html).not.toMatch(/<(?:iframe|object|embed|base)\b/);
    expect(compiled.html).not.toContain("javascript:");
    expect(compiled.html).not.toContain("ping=");
  });

  test.each(["math", "svg"])("foreign %s style mutation cannot authorize a handler or resource", (namespace) => {
    const payload = `<${namespace}><style><!--</style><img title="--><img src=x onerror=globalThis.mxss=1><meta http-equiv=Content-Security-Policy content=script-src\u0020*><link rel=dns-prefetch href=https://invalid.example><iframe srcdoc=x></iframe><base href=https://invalid.example>"></${namespace}>`;
    const compiled = compileHtml(source(payload), options);
    const nodes = elements(parse(compiled.html));

    const policy = nodes
      .find((n) => n.tagName === "meta" && n.attrs.some((a) => a.name === "http-equiv"))!
      .attrs.find((a) => a.name === "content")!.value;

    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("img-src data: blob:");
    expect(nodes.some((n) => n.tagName === "style" && n.namespaceURI !== "http://www.w3.org/1999/xhtml")).toBe(false);
    expect(nodes.some((n) => n.attrs.some((a) => a.name.startsWith("on")))).toBe(false);
    expect(compiled.hashes).not.toContain(htmlScriptHash("globalThis.mxss=1"));
  });

  test("shell keeps an opaque script-only sandbox and hash policy around the child", () => {
    const shell = mountVisualShell(source("<script>window.a=1</script>"), {
      title: "HTML",
      kitVersion: 2,
      htmlDocument: true,
      theme: {
        mode: "light",
        scale: 1,
        colors: {
          canvas: "#fff",
          surface: "#fff",
          panel: "#fff",
          hover: "#fff",
          ink: "#111",
          muted: "#555",
          border: "#ddd",
          accent: "#444",
          action: "#444",
          "action-hover": "#333",
          "on-accent": "#fff",
          info: "#444",
          success: "#444",
          warning: "#444",
          danger: "#444",
        },
      },
      reducedMotion: true,
      state: undefined,
      random: () => "test-shell-random-123456",
    });

    expect(shell.kind).toBe("ready");

    if (shell.kind !== "ready") return;
    expect(shell.html).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(shell.html).not.toContain("allow-same-origin");
    expect(shell.html).toContain("frame-src 'none'");
    expect(shell.html).toContain("script-src 'sha256-");
    const nodes = elements(parse(shell.html));

    const policy = nodes
      .find((n) => n.tagName === "meta" && n.attrs.some((a) => a.name === "http-equiv"))!
      .attrs.find((a) => a.name === "content")!.value;

    const executable = nodes.filter((n) => n.tagName === "script" && !n.attrs.some((a) => a.name === "type"));
    expect(executable).toHaveLength(1);

    for (const script of executable) {
      const code = script.childNodes.flatMap((n) => ("value" in n ? [n.value] : [])).join("");
      expect(code.startsWith(HTML_NETWORK_LOCKDOWN)).toBe(true);
      expect(policy).toContain(htmlScriptHash(code));
    }
  });

  test("bounds raw tool input before JSON parsing and bounds UTF-8 document size", () => {
    const oversizedInvalidJson = "{" + "x".repeat(512 * 1024 + 8192);
    const decoded = decodeAgentBusCall("render_html", oversizedInvalidJson);
    expect(Result.isFailure(decoded) && decoded.failure).toContain("arguments exceed");
    expect(() => compileHtml(source("🙂".repeat(140000)), options)).toThrow("512 KiB");
    expect(() => compileHtml(source("<script></script>".repeat(65)), options)).toThrow("64 scripts");
  });

  test("HTML rejects local state, invalid messages, forged envelopes and floods", () => {
    const inbox = new VisualFrameInbox(new Map(), true);
    const cyclic: CyclicFramePayload = { type: "height", height: 1 };
    cyclic.self = cyclic;
    expect(inbox.receive(cyclic, 0)).toBeUndefined();
    expect(inbox.receive({ type: "local_state", state: {} }, 0)).toBeUndefined();
    expect(inbox.receive({ type: "height", height: -1 }, 0)).toBeUndefined();
    expect(inbox.receive({ type: "open_url", url: "https://invalid.example" }, 0)).toBeUndefined();
    expect(openShellEnvelope('{"canopy_shell":"wrong","message":{"type":"escape"}}', "right")).toBeUndefined();

    for (let i = 0; i < 10; i++) inbox.receive({ type: "escape" }, 0);
    expect(inbox.receive({ type: "escape" }, 0)).toBeUndefined();
    expect(inbox.receive({ type: "escape" }, 1001)).toEqual({ type: "escape" });
  });
});
