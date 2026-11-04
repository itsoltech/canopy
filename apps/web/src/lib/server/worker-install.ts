import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";

/** Pull one chunk before returning HTTP headers so missing mirrors produce a useful HTTP error. */
export async function installResponse(
  api: Client<typeof ui.GatewayService>,
  os: string,
  arch: string,
  checksum: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const iterator = api
    .fetchWorkerInstall({ os, arch, metadataOnly: checksum }, { signal, timeoutMs: 300_000 })
    [Symbol.asyncIterator]();

  try {
    const first = await iterator.next();

    if (!first.value) throw new Error("Empty install response");
    const metadata = first.value;

    if (checksum) {
      await iterator.return?.();

      return new Response(metadata.sha256 + "\n", {
        headers: { "content-type": "text/plain", "cache-control": "no-store", "x-canopy-version": metadata.version },
      });
    }

    // Advance past metadata before committing headers (artifact verification may still fail).
    const next = await iterator.next();

    if (!next.value?.data.length) throw new Error("Empty worker binary");
    let initial = next.value.data;

    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (initial.length) {
              controller.enqueue(initial);
              initial = new Uint8Array();

              return;
            }

            const chunk = await iterator.next();

            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value.data);
          } catch (error) {
            controller.error(error);
            await iterator.return?.();
          }
        },
        async cancel() {
          await iterator.return?.();
        },
      }),
      {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "x-canopy-version": metadata.version,
          "x-checksum-sha256": metadata.sha256,
          "content-disposition": `attachment; filename="canopy-worker-${os}-${arch}"`,
          "x-content-type-options": "nosniff",
        },
      },
    );
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}
