import { isString, num, parseObject, str } from "@canopy/domain/json";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

type Action = "image" | "copy" | "file" | "external" | "copy-full-path" | "copy-relative-path" | "mermaid";

const pending = new Map<number, (payload: string | undefined) => void>();
let sequence = 0;
let images: Promise<unknown> = Promise.resolve();

export function request(action: Action, value: string): Promise<string> {
  function send() {
    return new Promise<string>((resolve, reject) => {
      const bridge = window.ReactNativeWebView;

      if (!bridge) return reject(new Error("Preview host unavailable"));
      const id = ++sequence;
      pending.set(id, (data) => (data === undefined ? reject(new Error("Preview action failed")) : resolve(data)));
      bridge.postMessage(JSON.stringify({ id, action, value }));
    });
  }

  if (action !== "image") return send();
  const image = images.then(send);
  images = image.catch(() => undefined);

  return image;
}

/** react-native-webview delivers native messages on the window on iOS and the document on Android. */
export function connectPreview() {
  function receive(event: Event) {
    if (!(event instanceof MessageEvent) || event.source || !isString(event.data)) return;
    const message = parseObject(event.data);
    const id = num(message["id"]);
    const resolve = pending.get(id);
    pending.delete(id);
    resolve?.(message["ok"] === true ? str(message["value"]) : undefined);
  }

  window.addEventListener("message", receive);
  document.addEventListener("message", receive);
}
