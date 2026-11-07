import { createHash } from "node:crypto";
import * as https from "node:https";
import * as tls from "node:tls";
import type { PinnedTransport } from "../../../apps/mobile/src/api/routes.ts";

const fingerprint = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");

/** Native module substitute using real TLS: both the probe and every HTTP connection verify the pin. */
export function nodePinnedTransport(): PinnedTransport {
  const certificates = new Map<string, string>();

  return {
    probe(origin, pin, signal) {
      return new Promise((resolve, reject) => {
        const url = new URL(origin);

        const socket = tls.connect({
          host: url.hostname,
          port: Number(url.port || 443),
          rejectUnauthorized: false,
          ...(signal && { signal }),
        });

        socket.setTimeout(2000, () => socket.destroy(new Error("Probe timeout")));
        socket.once("error", reject);
        socket.once("secureConnect", () => {
          const raw = socket.getPeerCertificate().raw;
          socket.destroy();

          if (!raw || fingerprint(raw) !== pin) {
            reject(new Error("Certificate mismatch"));

            return;
          }

          certificates.set(
            pin,
            `-----BEGIN CERTIFICATE-----\n${raw
              .toString("base64")
              .match(/.{1,64}/g)!
              .join("\n")}\n-----END CERTIFICATE-----\n`,
          );
          resolve();
        });
      });
    },
    fetch(url, init, pin) {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });

        const request = https.request(
          url,
          {
            method: init?.method ?? "POST",
            headers,
            ca: certificates.get(pin),
            rejectUnauthorized: true,
            checkServerIdentity: (_host, certificate) =>
              fingerprint(certificate.raw) === pin ? undefined : new Error("Certificate mismatch"),
            ...(init?.signal && { signal: init.signal }),
            agent: false,
          },
          (incoming) => {
            const responseHeaders = new Headers();

            for (const [name, value] of Object.entries(incoming.headers))
              if (value) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);

            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                incoming.on("data", (data: Buffer) => controller.enqueue(new Uint8Array(data)));
                incoming.once("end", () => controller.close());
                incoming.once("error", (error) => controller.error(error));
              },
              cancel() {
                incoming.destroy();
                request.destroy();
              },
            });

            resolve(new Response(body, { status: incoming.statusCode ?? 500, headers: responseHeaders }));
          },
        );

        request.once("error", reject);
        const body = init?.body;

        if (body instanceof Uint8Array) request.end(body);
        else request.end();
      });
    },
    // Every request already opens its own connection (`agent: false`).
    reset() {},
  };
}
