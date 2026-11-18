import { describe, expect, test } from "bun:test";
import { downloadSlackFile } from "../../apps/gateway/src/messengers/slack-files.ts";
import type { SlackTransport } from "../../apps/gateway/src/messengers/slack-http.ts";

const fileId = "F012AB3CDE4";
const token = "xoxe.xoxp-fixture";
const infoUrl = `https://slack.com/api/files.info?file=${fileId}`;
const fileUrl = "https://files.slack.com/files-pri/T0123-F012AB3CDE4/download/report.txt?ticket=fixture";
const file = { id: fileId, name: "report.txt", size: 3, url_private_download: fileUrl };

function transportFixture(responses: Response[]) {
  const requests: { request: Request; credentials: RequestInit["credentials"] }[] = [];

  const transport: SlackTransport = {
    fetch: async (input, init) => {
      requests.push({ request: new Request(input, init), credentials: init?.credentials });
      const response = responses.shift();

      if (!response) throw new Error("Unexpected Slack request");

      return response;
    },
  };

  return { requests, transport };
}

function metadata(overrides = {}) {
  return Response.json({ ok: true, file: { ...file, ...overrides } });
}

describe("Slack file download transport", () => {
  test.each(["xoxe.xoxp-fixture", "xoxe.xoxb-fixture"])(
    "uses the OAuth access token only on Slack and follows validated same-origin redirects (%s)",
    async (accessToken) => {
      const redirected = new URL("/files-pri/T0123-F012AB3CDE4/report.txt", fileUrl).href;

      const { requests, transport } = transportFixture([
        metadata({ url_private: "https://invalid.example/skipped" }),
        new Response(null, { status: 302, headers: { Location: new URL(redirected).pathname } }),
        new Response("abc"),
      ]);

      const result = await downloadSlackFile({ fileId, token: accessToken, maxBytes: 3, transport });
      expect(result).toEqual({ fileId, name: "report.txt", data: Buffer.from("abc") });
      expect(requests.map(({ request }) => request.url)).toEqual([infoUrl, fileUrl, redirected]);
      expect(requests.map(({ request }) => request.method)).toEqual(["GET", "GET", "GET"]);
      expect(requests.map(({ request }) => request.headers.get("authorization"))).toEqual(
        Array(3).fill(`Bearer ${accessToken}`),
      );
      expect(requests.map(({ request }) => request.redirect)).toEqual(["error", "manual", "manual"]);
      expect(requests.every((request) => request.credentials === "omit")).toBe(true);
    },
  );

  test.each([
    "https://files.slack.com.invalid.example/f",
    "https://invalid.example/f",
    "http://files.slack.com/f",
    "https://files.slack.com:8443/f",
    "https://account@files.slack.com/f",
    "blob:https://files.slack.com/f",
  ])("refuses untrusted metadata and redirect destinations (%s)", async (untrusted) => {
    const fromMetadata = transportFixture([metadata({ url_private_download: untrusted })]);
    await expect(
      downloadSlackFile({ fileId, token, maxBytes: 3, transport: fromMetadata.transport }),
    ).rejects.toMatchObject({ message: "Slack messenger: invalid_file_url" });
    expect(fromMetadata.requests.map(({ request }) => request.url)).toEqual([infoUrl]);

    const fromRedirect = transportFixture([
      metadata(),
      new Response(null, { status: 307, headers: { Location: untrusted } }),
    ]);

    await expect(
      downloadSlackFile({ fileId, token, maxBytes: 3, transport: fromRedirect.transport }),
    ).rejects.toMatchObject({ message: "Slack messenger: invalid_file_redirect" });
    expect(fromRedirect.requests.map(({ request }) => request.url)).toEqual([infoUrl, fileUrl]);
  });

  test("ends a redirect loop at the hop limit", async () => {
    const redirect = () => new Response(null, { status: 302, headers: { Location: fileUrl } });
    const { requests, transport } = transportFixture([metadata(), redirect(), redirect(), redirect()]);

    await expect(downloadSlackFile({ fileId, token, maxBytes: 3, transport })).rejects.toMatchObject({
      code: "invalid_file_redirect",
    });
    expect(requests).toHaveLength(4);
  });

  test("stops an aborted request before following a redirect and redacts the abort reason", async () => {
    const controller = new AbortController();
    const requests: string[] = [];

    const transport: SlackTransport = {
      fetch: async (url) => {
        requests.push(String(url));

        if (String(url) === infoUrl) return metadata();
        controller.abort(new Error(`Aborted ${fileUrl} with ${token}`));

        return new Response(null, { status: 302, headers: { Location: fileUrl } });
      },
    };

    await expect(
      downloadSlackFile({ fileId, token, maxBytes: 3, transport, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError", message: "Operation aborted" });
    expect(requests).toEqual([infoUrl, fileUrl]);
  });

  test("rejects noncanonical IDs before HTTP and mismatched or external files before download", async () => {
    const { requests, transport } = transportFixture([metadata({ id: "FOTHER" }), metadata({ is_external: true })]);

    await expect(downloadSlackFile({ fileId: `${fileId}\n`, token, maxBytes: 3, transport })).rejects.toMatchObject({
      code: "invalid_file_id",
    });
    expect(requests).toHaveLength(0);

    await expect(downloadSlackFile({ fileId, token, maxBytes: 3, transport })).rejects.toMatchObject({
      code: "invalid_file_response",
    });
    await expect(downloadSlackFile({ fileId, token, maxBytes: 3, transport })).rejects.toMatchObject({
      code: "file_not_hosted",
    });
    expect(requests.map(({ request }) => request.url)).toEqual([infoUrl, infoUrl]);
  });

  test("preflights the size and cancels an oversized stream even when Slack reports fewer bytes", async () => {
    const tooLarge = transportFixture([metadata({ size: 4 })]);
    await expect(
      downloadSlackFile({ fileId, token, maxBytes: 3, transport: tooLarge.transport }),
    ).rejects.toMatchObject({
      code: "file_too_large",
    });
    expect(tooLarge.requests).toHaveLength(1);

    const oversizeHeader = transportFixture([metadata(), new Response("abc", { headers: { "Content-Length": "4" } })]);

    await expect(
      downloadSlackFile({ fileId, token, maxBytes: 3, transport: oversizeHeader.transport }),
    ).rejects.toMatchObject({ code: "file_too_large" });

    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.enqueue(Uint8Array.of(3, 4));
      },
      cancel() {
        cancelled = true;
      },
    });

    const { transport } = transportFixture([metadata(), new Response(stream, { headers: { "Content-Length": "3" } })]);

    await expect(downloadSlackFile({ fileId, token, maxBytes: 3, transport })).rejects.toMatchObject({
      code: "file_too_large",
    });
    expect(cancelled).toBe(true);
  });

  test("accepts the private URL fallback and keeps credentials out of the returned name", async () => {
    const { requests, transport } = transportFixture([
      metadata({ name: token, url_private_download: undefined, url_private: fileUrl }),
      new Response("abc"),
    ]);

    await expect(downloadSlackFile({ fileId, token, maxBytes: 3, transport })).resolves.toEqual({
      fileId,
      name: fileId,
      data: Buffer.from("abc"),
    });
    expect(requests.map(({ request }) => request.url)).toEqual([infoUrl, fileUrl]);
  });

  test("distinguishes scope and access failures and redacts provider and network errors", async () => {
    const { transport } = transportFixture([
      Response.json({ ok: false, error: "missing_scope", needed: "files:read", detail: token }),
      Response.json({ ok: false, error: "file_not_found" }),
      metadata(),
      new Response(`Provider body with ${token} and ${fileUrl}`, { status: 403 }),
      Response.json({ ok: false, error: `Rejected ${token} at ${fileUrl}` }),
    ]);

    const input = { fileId, token, maxBytes: 3, transport };

    await expect(downloadSlackFile(input)).rejects.toMatchObject({ code: "missing_scope" });
    await expect(downloadSlackFile(input)).rejects.toMatchObject({ code: "access_denied" });
    await expect(downloadSlackFile(input)).rejects.toMatchObject({ code: "access_denied" });
    await expect(downloadSlackFile(input)).rejects.toMatchObject({ message: "Slack messenger: file_unavailable" });

    const fetcher: NonNullable<SlackTransport["fetch"]> = async (url) => {
      if (String(url) === infoUrl) return metadata();
      throw new Error(`Transport failure at ${fileUrl} with ${token}`);
    };

    await expect(downloadSlackFile({ ...input, transport: { fetch: fetcher } })).rejects.toMatchObject({
      message: "Slack messenger: file_unavailable",
    });
  });
});
