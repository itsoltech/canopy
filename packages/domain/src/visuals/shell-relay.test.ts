import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { compileVisualShell } from "./shell.ts";
import type { JsonValue } from "../json.ts";

interface FramePayload {
  type: string;
  height: number;
  hidden: ArrayBuffer;
}

interface PortStub {
  onmessage?: (event: { data: FramePayload }) => void;
}

interface HostEvent {
  source: object;
  data: { type: string; instance: string; nonce: string };
  ports: { postMessage: (message: JsonValue) => void }[];
}

function scripts(node: DefaultTreeAdapterMap["node"]): string[] {
  if ("tagName" in node && node.tagName === "script")
    return [node.childNodes.flatMap((child) => ("value" in child ? [child.value] : [])).join("")];

  return "childNodes" in node ? node.childNodes.flatMap(scripts) : [];
}

test.each([false, true])("locked shell relays the checked JSON copy (native bridge: %s)", (native) => {
  const [data, program] = scripts(
    parse(
      compileVisualShell({
        title: "test",
        html: "",
        nonce: "nonce",
        instance: "instance",
        token: "token",
        scriptHashes: [],
      }),
    ),
  );

  const parent = {};
  const relayed: JsonValue[] = [];
  let receiveHost: ((event: HostEvent) => void) | undefined;

  class Channel {
    static current: Channel;
    port1: PortStub = {};
    port2 = {};
    constructor() {
      Channel.current = this;
    }
  }

  const frame = { setAttribute() {}, addEventListener() {} };

  const bridge = { postMessage: (text: string) => relayed.push(JSON.parse(text).message) };

  const context = {
    parent,
    MessageChannel: Channel,
    // The VM must not traverse and lock a prototype owned by the surrounding test process.
    navigator: Object.create(null),
    RTCPeerConnection: class {},
    fetch: () => {},
    window: {
      ReactNativeWebView: native ? bridge : undefined,
      addEventListener(_type: string, callback: (event: HostEvent) => void) {
        receiveHost = callback;
      },
    },
    document: {
      getElementById: () => ({ textContent: data }),
      createElement: () => frame,
      addEventListener() {},
      body: { appendChild() {} },
    },
  };

  runInNewContext(program!, context);
  expect(context.RTCPeerConnection).toBeUndefined();
  expect(context.fetch).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(context, "RTCPeerConnection")?.configurable).toBe(false);
  expect(Object.getOwnPropertyDescriptor(context, "fetch")?.writable).toBe(false);
  // A copied shell program locks a fresh realm too, while the trusted shell retains native messaging.
  expect(context.window.ReactNativeWebView).toBe(native ? bridge : undefined);
  receiveHost?.({
    source: parent,
    data: { type: "connect", instance: "instance", nonce: "nonce" },
    ports: [{ postMessage: (message: JsonValue) => relayed.push(message) }],
  });
  const payload = { type: "height", height: 300, hidden: new ArrayBuffer(8 * 1024 * 1024) };
  Channel.current.port1.onmessage?.({ data: payload });
  expect(relayed).toEqual([{ type: "height", height: 300, hidden: {} }]);
  expect(relayed[0]).not.toBe(payload);
});
