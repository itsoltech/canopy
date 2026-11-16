import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { BrowserWindow, Session, WebContents } from "electron";
import { DesktopWebSession, DESKTOP_SESSION_HEADER } from "../src/web-session.ts";
import { desktopWebListener } from "../src/runtime/web-auth.ts";
import { windowContents } from "../src/window-message.ts";

test("the desktop listener authenticates documents, assets, API, mutations and SSE before the handler", async () => {
  let origin = "";
  const session = new DesktopWebSession(() => origin);
  const nextSession = new DesktopWebSession(() => origin);
  let calls = 0;

  const server = createServer((request, response) =>
    desktopWebListener(origin, session.token, (req, res) => {
      calls++;
      expect(req.headers[DESKTOP_SESSION_HEADER]).toBeUndefined();
      res.writeHead(200, { "content-type": req.url === "/events" ? "text/event-stream" : "text/plain" });
      res.end(req.url === "/events" ? "data: ready\n\n" : "ready");
    })(request, response),
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: listening has completed on an IPv4 TCP listener, never a Unix socket.
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  try {
    for (const path of ["/", "/desktop", "/_app/immutable/app.js", "/api/overview", "/events"]) {
      for (const token of ["", "wrong", nextSession.token]) {
        const denied = await fetch(origin + path, {
          headers: { origin, "sec-fetch-site": "same-origin", [DESKTOP_SESSION_HEADER]: token },
        });

        expect(denied.status).toBe(403);
        expect(denied.headers.get("cache-control")).toBe("no-store");
        expect(denied.headers.get("connection")).toBe("close");
      }
    }

    expect(calls).toBe(0);

    for (const [path, method] of [
      ["/", "GET"],
      ["/desktop", "GET"],
      ["/_app/immutable/app.js", "GET"],
      ["/events", "GET"],
      ["/api/mutate", "POST"],
    ] as const) {
      const response = await fetch(origin + path, { method, headers: session.headers(origin + path) });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(path === "/events" ? "data: ready\n\n" : "ready");
    }

    for (const headers of [
      { origin: "https://foreign.invalid" },
      { host: "foreign.invalid" },
      { "sec-fetch-site": "cross-site" },
    ])
      expect((await fetch(origin, { headers: { ...session.headers(origin), ...headers } })).status).toBe(403);

    const callback = `${origin}/api/connectors/oauth/callback?code=test&state=test`;
    expect(
      (
        await fetch(callback, {
          headers: {
            origin: "https://provider.invalid",
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        })
      ).status,
    ).toBe(200);

    for (const path of [
      "/api/connectors/oauth/callback/",
      "/api/connectors/oauth/callback/extra",
      "/api/connectors/oauth/code",
    ])
      expect((await fetch(origin + path)).status).toBe(403);
    expect((await fetch(callback, { method: "POST" })).status).toBe(403);
    expect((await fetch(callback, { headers: { "sec-fetch-mode": "cors" } })).status).toBe(403);
    expect((await fetch(callback, { headers: { "sec-fetch-dest": "iframe" } })).status).toBe(403);
    expect((await fetch(callback, { headers: { host: "foreign.invalid" } })).status).toBe(403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Electron only adds the capability to its own top frame and strips it on external redirects", () => {
  const origin = "http://127.0.0.1:25001";
  const capability = new DesktopWebSession(() => origin);

  let before:
    | ((
        details: Electron.OnBeforeSendHeadersListenerDetails,
        callback: (response: Electron.BeforeSendResponse) => void,
      ) => void)
    | undefined;

  // SAFETY: the mock implements precisely the session hook used by DesktopWebSession.attach.
  const session = {
    webRequest: {
      onBeforeSendHeaders: (_filter: Electron.WebRequestFilter, listener: typeof before) => {
        before = listener;
      },
    },
  } as Session;

  // SAFETY: the hook only reads id and isDestroyed on these trusted WebContents.
  const contents = { id: 1, isDestroyed: () => false } as WebContents;
  capability.attach(session, () => [contents]);

  const send = (patch: Partial<Electron.OnBeforeSendHeadersListenerDetails> = {}) => {
    let result: Electron.BeforeSendResponse = {};
    // SAFETY: unrelated Electron timing and upload metadata are unused by this hook.
    before!(
      {
        url: origin,
        resourceType: "xhr",
        webContentsId: 1,
        frame: { url: origin, parent: null },
        initiatorOrigin: origin,
        requestHeaders: {},
        ...patch,
      } as Electron.OnBeforeSendHeadersListenerDetails,
      (response) => {
        result = response;
      },
    );

    return result;
  };

  expect(send().requestHeaders?.[DESKTOP_SESSION_HEADER]).toBe(capability.token);
  expect(send({ resourceType: "mainFrame", frame: null }).requestHeaders?.[DESKTOP_SESSION_HEADER]).toBe(
    capability.token,
  );
  expect(send({ webContentsId: 2 }).cancel).toBe(true);
  expect(send({ frame: null }).cancel).toBe(true);
  expect(send({ initiatorOrigin: "null" }).cancel).toBe(true);
  // SAFETY: only frame.parent and frame.url are used; a parent marks an untrusted child frame.
  expect(send({ frame: { url: origin, parent: {} } as Electron.WebFrameMain }).cancel).toBe(true);
  expect(
    send({ url: "https://external.invalid", requestHeaders: { "X-Canopy-Desktop-Session": capability.token } })
      .requestHeaders,
  ).toEqual({});
  expect(capability.headers("https://external.invalid")).toEqual({});

  let stopped = false;

  // SAFETY: revocation only checks isDestroyed and stops loading on live WebContents.
  const revoking = {
    isDestroyed: () => false,
    stop: () => {
      stopped = true;
    },
  } as WebContents;

  capability.revoke([revoking]);
  expect(stopped).toBe(true);
  expect(send({ resourceType: "mainFrame", frame: null }).cancel).toBe(true);
  expect(send().cancel).toBe(true);
  expect(() => capability.headers(origin)).toThrow("Desktop services stopped");
});

test("closing the main window preserves authentication for settings and cannot prevent session revocation", () => {
  const origin = "http://127.0.0.1:25001";
  const capability = new DesktopWebSession(() => origin);
  let closed = false;
  let stopped = 0;

  let before:
    | ((
        details: Electron.OnBeforeSendHeadersListenerDetails,
        callback: (response: Electron.BeforeSendResponse) => void,
      ) => void)
    | undefined;

  // SAFETY: the session fixture only implements the header hook used by attach.
  const session = {
    webRequest: {
      onBeforeSendHeaders: (_filter: Electron.WebRequestFilter, listener: typeof before) => {
        before = listener;
      },
    },
  } as Session;

  // SAFETY: session authentication and revocation only use id, isDestroyed and stop.
  const contents = {
    id: 1,
    isDestroyed: () => closed,
    stop: () => {
      stopped++;
    },
  } as WebContents;

  // SAFETY: reproduce Electron's throwing native getter after BrowserWindow destruction.
  const main = {
    isDestroyed: () => closed,
    get webContents() {
      if (closed) throw new TypeError("Object has been destroyed");

      return contents;
    },
  } as BrowserWindow;

  // SAFETY: the surviving settings window only exposes the fields used by windowContents.
  const settings = {
    isDestroyed: () => false,
    webContents: { ...contents, id: 2, isDestroyed: () => false },
  } as BrowserWindow;

  const windows = () => [windowContents(main), windowContents(settings)];
  capability.attach(session, windows);

  const request = (webContentsId: number) => {
    let response: Electron.BeforeSendResponse | undefined;
    // SAFETY: main-frame requests do not use any other Electron metadata in the header hook.
    before!(
      {
        url: origin,
        resourceType: "mainFrame",
        webContentsId,
        requestHeaders: {},
      } as Electron.OnBeforeSendHeadersListenerDetails,
      (result) => {
        response = result;
      },
    );

    return response;
  };

  expect(request(1)?.requestHeaders?.[DESKTOP_SESSION_HEADER]).toBe(capability.token);
  closed = true;
  expect(request(1)).toEqual({ cancel: true });
  expect(request(2)?.requestHeaders?.[DESKTOP_SESSION_HEADER]).toBe(capability.token);
  expect(request(3)).toEqual({ cancel: true });

  capability.revoke(windows());
  expect(stopped).toBe(1);
  expect(request(2)).toEqual({ cancel: true });
  expect(() => capability.headers(origin)).toThrow("Desktop services stopped");
});
