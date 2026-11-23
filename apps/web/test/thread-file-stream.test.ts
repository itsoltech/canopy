import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { FileResolution, ui } from "@canopy/contracts";
import { THREAD_FILE_DOWNLOAD_CHUNK_BYTES } from "@canopy/domain/thread-files";
import { threadFileStream } from "../src/lib/server/thread-file-stream.ts";

const target = { threadId: "thread", path: "clip.mp4", itemId: "message" };
const revision = "a".repeat(64);
const chunkSize = THREAD_FILE_DOWNLOAD_CHUNK_BYTES;
const size = 3 * chunkSize + 71;
const movie = new Uint8Array(size);

movie.set(Uint8Array.fromHex("000000186674797069736f6d0000020069736f6d6d703431"));

movie.fill(0xaf, size - 128);

function source(bytes = movie, legacy = false) {
  const reads: { offset: number; length: number; revision: string }[] = [];

  const api: Pick<Client<typeof ui.GatewayService>, "readThreadFile"> = {
    async readThreadFile(request) {
      const { downloadRange } = create(ui.ThreadFileRequestSchema, request);

      if (!downloadRange) throw new Error("Expected a bounded read");
      const offset = Number(downloadRange.offset);
      const content = bytes.subarray(offset, offset + (legacy ? chunkSize : downloadRange.maxBytes));
      reads.push({ offset, length: content.length, revision: downloadRange.expectedRevision });

      return create(ui.ThreadFileSchema, {
        path: "/workspace/clip.mp4",
        size: BigInt(bytes.length),
        resolution: FileResolution.FOUND,
        content,
        downloadChunk: { offset: downloadRange.offset, revision },
      });
    },
  };

  const serve = (options?: RequestInit) =>
    threadFileStream(api, target, new Request("http://localhost/video", options), "video");

  return { api, reads, serve };
}

test("a player can probe two bytes and seek beyond the preview limit on current and older workers", async () => {
  for (const legacy of [false, true]) {
    const { serve, reads } = source(movie, legacy);
    const probe = await serve({ headers: { range: "bytes=0-1" } });
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
    expect(probe.headers.get("accept-ranges")).toBe("bytes");
    expect(probe.headers.get("content-type")).toBe("video/mp4");
    expect(probe.headers.get("content-length")).toBe("2");
    expect(probe.headers.get("x-content-type-options")).toBe("nosniff");
    expect(probe.headers.get("content-security-policy")).toContain("sandbox");
    expect(await probe.bytes()).toEqual(movie.subarray(0, 2));

    const start = size - 100;
    const end = size - 12;
    const seek = await serve({ headers: { range: `bytes=${start}-${end}`, "if-range": `"${revision}"` } });
    expect(seek.status).toBe(206);
    expect(seek.headers.get("content-range")).toBe(`bytes ${start}-${end}/${size}`);
    expect(reads).toHaveLength(2);
    expect(await seek.bytes()).toEqual(movie.subarray(start, end + 1));
    expect(reads).toEqual([
      { offset: 0, length: legacy ? chunkSize : 4096, revision: "" },
      { offset: 0, length: legacy ? chunkSize : 4096, revision: "" },
      { offset: start, length: legacy ? size - start : end - start + 1, revision },
    ]);
  }
});

test("suffix and open ranges stop at EOF and invalid ranges fetch no body", async () => {
  const { serve, reads } = source();

  for (const range of ["bytes=-7", `bytes=${size - 7}-`, `bytes=${size - 7}-${size + 1}`]) {
    const response = await serve({ headers: { range } });
    expect(response.headers.get("content-length")).toBe("7");
    expect(await response.bytes()).toEqual(movie.subarray(size - 7));
  }

  const before = reads.length;

  for (const range of [`bytes=${size}-`, "bytes=2-1", "bytes=0-1,4-5"]) {
    const response = await serve({ headers: { range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
    expect(response.body).toBeNull();
  }

  expect(reads).toHaveLength(before + 3);
});

test("HEAD and a stale If-Range describe the whole revision and a canceled player stops pulling", async () => {
  const { serve, reads } = source();
  const head = await serve({ method: "HEAD", headers: { range: "bytes=0-1" } });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(size));
  expect(head.headers.get("etag")).toBe(`"${revision}"`);
  expect(head.body).toBeNull();
  const response = await serve({ headers: { range: "bytes=7000-", "if-range": '"old"' } });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe(String(size));
  expect(response.headers.has("content-range")).toBe(false);

  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(movie.subarray(0, 4096));
  expect((await reader.read()).value?.length).toBe(chunkSize);
  await reader.cancel();
  expect(reads.map((read) => read.offset)).toEqual([0, 0, 4096]);
});

test("a video filename cannot enable inline document content, and a changed revision stops the stream", async () => {
  const markup = new TextEncoder().encode("<html><title>file</title></html>");
  await expect(source(markup).serve()).rejects.toMatchObject({ status: 415 });
  const { api } = source();

  const response = await threadFileStream(
    {
      async readThreadFile(request, options) {
        const file = await api.readThreadFile(request, options);

        if (file.downloadChunk?.offset) file.downloadChunk.revision = "b".repeat(64);

        return file;
      },
    },
    target,
    new Request("http://localhost/video", { headers: { range: "bytes=9000-9100" } }),
    "video",
  );

  await expect(response.arrayBuffer()).rejects.toThrow("file changed");
});

test("downloads preserve the entire original file and its attachment disposition", async () => {
  const { api, reads } = source();
  const request = new Request("http://localhost/download");
  const check = await threadFileStream(api, target, request, "check");
  expect(await check.json()).toEqual({});
  expect(reads).toHaveLength(1);

  const download = await threadFileStream(api, target, request, "download");
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toStartWith("attachment;");
  expect(download.headers.get("content-type")).toBe("application/octet-stream");
  expect(download.headers.get("content-length")).toBe(String(size));
  expect(Buffer.from(await download.arrayBuffer()).equals(movie)).toBe(true);
});
