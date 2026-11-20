import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { fileResponse } from "../src/lib/server/files.ts";
import { workspaceImageResponse } from "../src/lib/server/workspace-image.ts";

test("workspace and attachment SVG previews are sandboxed HTTP documents and the original remains downloadable", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle r="3"/></svg>';
  const bytes = new TextEncoder().encode(svg);
  const file = create(ui.ThreadFileSchema, { mimeType: "image/svg+xml", content: bytes, size: BigInt(bytes.length) });
  const workspace = workspaceImageResponse(file);
  const attachment = fileResponse(bytes, file.mimeType, { image: true });

  for (const response of [workspace, attachment]) {
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(svg);
  }

  expect(workspace.headers.get("cache-control")).toContain("no-store");
  const download = fileResponse(bytes, file.mimeType, { download: true, name: "shape.svg" });
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(await download.text()).toBe(svg);
  expect(workspaceImageResponse(create(ui.ThreadFileSchema, { ...file, truncated: true })).status).toBe(415);
  expect(workspaceImageResponse(create(ui.ThreadFileSchema, { ...file, mimeType: "text/plain" })).status).toBe(415);
});

test("raster downloads preserve their MIME and bytes while unsafe workspace dimensions cannot be previewed", async () => {
  const bytes = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO6kAAAAASUVORK5CYII=",
  );

  const file = create(ui.ThreadFileSchema, {
    mimeType: "image/png",
    content: bytes,
    size: BigInt(bytes.length),
    imageWidth: 1,
    imageHeight: 1,
  });

  for (const response of [workspaceImageResponse(file), fileResponse(bytes, file.mimeType, { download: true })]) {
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  }

  expect(workspaceImageResponse(create(ui.ThreadFileSchema, { ...file, imageWidth: 17_000_000 })).status).toBe(415);
});
