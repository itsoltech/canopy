import { expect, test } from "bun:test";
import { tempDirs } from "@canopy/testing";
import { BotWorkspace } from "./workspace.ts";
import { connectBotDownload, downloadBotFile, publicBotAddress, type BotDownloadOptions } from "./download.ts";

const temp = tempDirs();
const signal = () => new AbortController().signal;

test("downloads reject declared oversize before consuming bytes and bound DNS time", async () => {
  const workspace = new BotWorkspace(temp("canopy-download-declared-"));
  let consumed = false;

  await expect(
    downloadBotFile(workspace, "http://download.fixture/large.txt", "", signal(), {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      maxBytes: 8,
      connect: async () => ({
        status: 200,
        headers: new Headers({ "Content-Length": "9" }),
        body: (async function* () {
          consumed = true;
          yield new Uint8Array(9);
        })(),
        close() {},
      }),
    }),
  ).rejects.toThrow("size limit");
  expect(consumed).toBe(false);
  await expect(
    downloadBotFile(workspace, "http://download.fixture/slow.txt", "", signal(), {
      resolve: () => new Promise(() => {}),
      timeoutMs: 50,
    }),
  ).rejects.toThrow("timed out");
  expect(workspace.list()).toEqual([]);
});

test("downloads block nonpublic IPv4, IPv6, mapped IPv4, metadata and ambiguous DNS answers", async () => {
  const workspace = new BotWorkspace(temp("canopy-download-address-"));

  for (const address of [
    "0.0.0.0",
    "127.0.0.1",
    "10.1.2.3",
    "100.100.100.200",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "168.63.129.16",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "ff02::1",
  ])
    expect(publicBotAddress(address)).toBe(false);

  expect(publicBotAddress("93.184.216.34")).toBe(true);
  expect(publicBotAddress("2606:4700::1111")).toBe(true);
  let connected = false;

  for (const url of [
    "file:///etc/passwd",
    "http://user:secret@download.fixture/file",
    "http://127.0.0.1/file",
    "http://[::ffff:127.0.0.1]/file",
    "http://download.fixture/file",
  ])
    await expect(
      downloadBotFile(workspace, url, "file.txt", signal(), {
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
        connect: async () => {
          connected = true;
          throw new Error("must not connect");
        },
      }),
    ).rejects.toThrow();

  expect(connected).toBe(false);
});

test("local fixtures cover pinning, private redirects, streamed size limits, timeout and MIME", async () => {
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;

      if (path === "/redirect") return Response.redirect("http://private.fixture/file", 302);

      if (path === "/loop") return Response.redirect("http://download.fixture/loop", 302);

      if (path === "/large")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16));
              controller.close();
            },
          }),
        );

      if (path === "/stall")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        );

      return new Response("# Note", { headers: { "Content-Type": "text/markdown", "Content-Length": "6" } });
    },
  });

  const workspace = new BotWorkspace(temp("canopy-download-http-"));
  let resolutions = 0;
  let connections = 0;

  const options: BotDownloadOptions = {
    resolve: async (host) => {
      resolutions++;

      return [{ address: host === "private.fixture" ? "10.0.0.1" : "93.184.216.34", family: 4 }];
    },
    connect: async (url, address, abort) => {
      connections++;
      expect(address.address).toBe("93.184.216.34");

      return connectBotDownload(new URL(url.pathname, fixture.url), { address: "127.0.0.1", family: 4 }, abort);
    },
  };

  try {
    expect(await downloadBotFile(workspace, "http://download.fixture/note.md", "", signal(), options)).toMatchObject({
      name: "note.md",
      size_bytes: 6,
      mime_type: "text/markdown",
    });
    expect((await workspace.read("note.md")).toString()).toBe("# Note");
    expect(resolutions).toBe(1);
    expect(connections).toBe(1);
    await expect(
      downloadBotFile(workspace, "http://download.fixture/redirect", "redirect.txt", signal(), options),
    ).rejects.toThrow("not public");
    await expect(
      downloadBotFile(workspace, "http://download.fixture/loop", "loop.txt", signal(), options),
    ).rejects.toThrow("redirected");
    await expect(
      downloadBotFile(workspace, "http://download.fixture/large", "large.txt", signal(), { ...options, maxBytes: 8 }),
    ).rejects.toThrow("size limit");
    await expect(
      downloadBotFile(workspace, "http://download.fixture/stall", "stall.txt", signal(), { ...options, timeoutMs: 50 }),
    ).rejects.toThrow();
    expect(workspace.list().map((file) => file.name)).toEqual(["note.md"]);

    // The resolver would rebind on a second lookup. The transport receives the first address directly.
    let calls = 0;
    await downloadBotFile(workspace, "http://download.fixture/note.md", "pinned.md", signal(), {
      ...options,
      resolve: async () => [{ address: ++calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
    });
    expect(calls).toBe(1);
  } finally {
    await fixture.stop(true);
  }
});
