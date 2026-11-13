import { Directory, File, FileMode, Paths } from "expo-file-system";
import { Linking, Platform, Share } from "react-native";
import * as Crypto from "expo-crypto";
import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";

const cache = () => new Directory(Paths.cache, "diagnostics-logs");

export function clearDiagnosticLogs() {
  const directory = cache();

  if (directory.exists) directory.delete();
}

/** Sequential 32 KiB writes to private cache; the ZIP is never assembled in JS heap. */
export async function exportDiagnosticLogs(
  api: Client<typeof ui.GatewayService>,
  job: ui.DiagnosticsLogsJob,
  signal: AbortSignal,
) {
  const directory = cache();
  directory.create({ intermediates: true, idempotent: true });
  const name = `canopy-diagnostics-${Number(job.createdAtMs)}.zip`;
  const file = new File(directory, name);
  file.create({ overwrite: true });
  const handle = file.open(FileMode.WriteOnly);
  let sequence = 0;
  let bytes = 0;
  let complete = false;
  const abort = new AbortController();

  const timer = setTimeout(
    () => {
      abort.abort();

      if (file.exists) file.delete();
    },
    15 * 60 * 1000,
  );

  const combined = AbortSignal.any([signal, abort.signal]);

  try {
    try {
      for await (const part of api.downloadDiagnosticsLogs(
        { jobId: job.jobId },
        { signal: combined, timeoutMs: 180_000 },
      )) {
        combined.throwIfAborted();

        if (part.sequence !== sequence++) throw new Error("Invalid log download sequence");

        if (part.end) {
          complete = true;
          break;
        }

        bytes += part.data.length;

        if (!part.data.length || part.data.length > 32 * 1024 || bytes > 100 * 1024 * 1024)
          throw new Error("Log download limit reached");

        const digest = new Uint8Array(
          await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(part.data)),
        );

        const checksum = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");

        if (checksum !== part.checksum) throw new Error("Invalid log download checksum");
        await handle.writeBytes(part.data);
      }
    } finally {
      handle.close();
    }

    if (!complete || BigInt(bytes) !== job.bytes) throw new Error("Log download ended early");
    combined.throwIfAborted();

    if (Platform.OS === "android") {
      const folder = await Directory.pickDirectoryAsync();
      combined.throwIfAborted();
      const destination = folder.createFile(name, "application/zip");

      try {
        await file.copy(destination, { overwrite: true });
      } catch (error) {
        if (destination.exists) destination.delete();
        throw error;
      }

      const canOpen = await Linking.canOpenURL(folder.uri).catch(() => false);

      return {
        message: `Saved ${name} to ${folder.name || "the selected folder"}.`,
        folder: canOpen ? folder.uri : "",
      };
    }

    const result = await Share.share({ url: file.uri });

    return { message: result.action === Share.sharedAction ? "Logs shared." : "", folder: "" };
  } finally {
    clearTimeout(timer);

    if (file.exists) file.delete();
  }
}
