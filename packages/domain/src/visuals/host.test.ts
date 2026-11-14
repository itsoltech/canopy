import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { compileVisual, visualToken } from "./compile.ts";
import { openShellEnvelope, SHELL_MESSAGE_CHARS, shellEnvelope, VisualFrameInbox } from "./host.ts";
import { VISUAL_KIT_VERSION, VISUAL_LIMITS } from "./limits.ts";
import { compileVisualShell, mountVisualShell, shellPolicy } from "./shell.ts";
import { decodeVisualSpec, type DecodedVisual } from "./spec.ts";
import { visualTheme } from "./theme.ts";

function visual(): DecodedVisual {
  const decoded = decodeVisualSpec({
    schema_version: 1,
    state: { variant: "a" },
    root: {
      type: "stack",
      children: [
        { type: "heading", text: "</script><script>alert(1)</script>" },
        { type: "segmented", label: "Variant", state_key: "variant", options: ["a", "b"] },
      ],
    },
  });

  if (Result.isFailure(decoded)) throw new Error(decoded.failure);

  return decoded.success;
}

describe("visual host inbox", () => {
  test("rate-limits messages and heights and checks state against the spec", () => {
    const inbox = new VisualFrameInbox(visual().domains);

    expect(inbox.receive({ type: "local_state", state: { variant: "b" } }, 0)?.type).toBe("local_state");
    expect(inbox.receive({ type: "local_state", state: { variant: "evil" } }, 1)).toBeUndefined();
    expect(inbox.receive({ type: "local_state", state: { other: "a" } }, 2)).toBeUndefined();

    const heights = Array.from({ length: 8 }, (_, i) => inbox.receive({ type: "height", height: 300 + i }, 10 + i));
    expect(heights.filter(Boolean)).toHaveLength(VISUAL_LIMITS.heightsPerSecond + 1);

    // The message window is full now: even a valid escape waits for the next second.
    expect(inbox.receive({ type: "escape" }, 20)).toBeUndefined();
    expect(inbox.receive({ type: "escape" }, 1500)).toEqual({ type: "escape" });
  });

  test("takes hover as a bare boolean, at most hoversPerSecond", () => {
    const inbox = new VisualFrameInbox(visual().domains);

    expect(inbox.receive({ type: "hover", inside: "yes" }, 0)).toBeUndefined();
    expect(inbox.receive({ type: "hover" }, 1)).toBeUndefined();
    expect(inbox.receive({ type: "hover", inside: true, x: 10, y: 20 }, 2)).toEqual({ type: "hover", inside: true });

    const hovers = Array.from({ length: 6 }, (_, i) => inbox.receive({ type: "hover", inside: i % 2 === 0 }, 10 + i));
    expect(hovers.filter(Boolean)).toHaveLength(VISUAL_LIMITS.hoversPerSecond - 1);
    expect(inbox.receive({ type: "hover", inside: false }, 1100)).toEqual({ type: "hover", inside: false });
  });
});

describe("mobile shell", () => {
  test("relays only enveloped messages with this mount's token, within the size cap", () => {
    const token = visualToken();

    expect(openShellEnvelope(shellEnvelope(token, { type: "escape" }), token)).toEqual({ type: "escape" });
    expect(openShellEnvelope(shellEnvelope("other", { type: "escape" }), token)).toBeUndefined();
    expect(openShellEnvelope(JSON.stringify({ type: "escape" }), token)).toBeUndefined();
    expect(openShellEnvelope("not json", token)).toBeUndefined();
    expect(openShellEnvelope(shellEnvelope("", { type: "escape" }), "")).toBeUndefined();
    expect(
      openShellEnvelope(
        shellEnvelope(token, { type: "render_error", message: "x".repeat(SHELL_MESSAGE_CHARS) }),
        token,
      ),
    ).toBeUndefined();
  });

  test("keeps the token out of the frame and the visual's text inert", () => {
    const nonce = visualToken();
    const token = visualToken();
    const instance = "a1";
    const html = compileVisual(visual(), { title: "t", mode: "frame", nonce, instance });
    const shell = compileVisualShell({ title: '</title><script>alert("t")</script>', html, nonce, instance, token });

    expect(shell).toContain(`content="${shellPolicy(nonce)}"`);
    expect(shell.match(/<script/g)).toHaveLength(2);
    expect(shell).not.toContain("<script>alert");

    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"])
      expect(shellPolicy(nonce)).toContain(directive);

    const start = shell.indexOf('id="canopy-shell-data">') + 23;
    const data = JSON.parse(shell.slice(start, shell.indexOf("</script>", start)));

    expect(data.html).toBe(html);
    expect(data.html).not.toContain(token);
    expect(data.connect).toEqual({ canopy_visual: 1, type: "connect", instance, nonce });
    expect(shell).toContain('setAttribute("sandbox", "allow-scripts")');
  });

  test("mounts only specs that parse, with a kit this host may run, and fresh identifiers", () => {
    const spec = JSON.stringify({ schema_version: 1, root: { type: "text", text: "Hi" } });

    const options = {
      title: "t",
      kitVersion: 1,
      theme: visualTheme("birch", "light"),
      reducedMotion: false,
      state: { foreign: "x" },
      random: visualToken,
    };

    const first = mountVisualShell(spec, options);
    const second = mountVisualShell(spec, options);

    if (first.kind !== "ready" || second.kind !== "ready") throw new Error("expected a mount");
    expect(first.token).not.toBe(second.token);
    expect(first.html).toContain('\\"state\\":{}');
    expect(mountVisualShell(spec, { ...options, kitVersion: VISUAL_KIT_VERSION + 1 }).kind).toBe("update");
    expect(mountVisualShell('{"schema_version":1,"root":{"type":"script"}}', options).kind).toBe("invalid");
  });
});
