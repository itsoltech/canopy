import { Directory, File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { ComposerLocalStore } from "@canopy/domain/composer-drafts";
import { composerTargetKey } from "@canopy/domain/composer-drafts";
import { fromJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { DeviceSession } from "../../storage/session";
import { MobileDrafts } from "./store";

/** Documents survive cache eviction. Pairing ID and certificate isolate gateways and owners. */
export async function prepareMobileDrafts(session: DeviceSession | null) {
  const directory = new Directory(Paths.document, "composer-drafts-v1");
  directory.create({ idempotent: true, intermediates: true });
  const scope = session ? `${session.deviceId}-${session.fingerprint}` : "";

  if (scope && !/^[a-f0-9-]+$/.test(scope)) throw new Error("Invalid draft pairing");

  for (const entry of directory.list()) if (entry.name !== `${scope}.json` && entry.name !== scope) entry.delete();

  if (!session) return null;
  const file = new File(directory, `${scope}.json`);
  const records = new Directory(directory, scope);
  records.create({ idempotent: true });
  let writing = Promise.resolve();

  const local = new ComposerLocalStore(
    (key, raw) => {
      writing = writing
        .then(async () => {
          const name = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
          const destination = new File(records, `${name}.json`);

          if (raw === null) {
            if (destination.exists) destination.delete();

            return;
          }

          const pending = new File(records, `${name}.pending`);
          await pending.write(raw);
          await pending.move(destination, { overwrite: true });
        })
        .catch(() => {
          local.error = "Could not keep this draft. Free some storage, then retry.";
        });
    },
    () => Crypto.randomUUID(),
    () => writing,
  );

  local.load(file.exists ? await file.text() : null);

  if (file.exists) {
    for (const entry of local.list()) {
      const target = entry.draft?.target;

      if (target) {
        local.remove(target);
        local.put(entry);
      }
    }

    await local.checkpoint();
    file.delete();
  }

  for (const record of records.list()) {
    if (!(record instanceof File) || !record.name.endsWith(".json")) continue;
    const raw = await record.text();

    try {
      const entry = fromJsonString(ui.LocalComposerDraftSchema, raw);

      if (entry.draft?.target) local.receive(composerTargetKey(entry.draft.target), raw);
    } catch {
      local.error = "Could not restore a draft. Start a new draft.";
    }
  }

  return new MobileDrafts(local, session.deviceId, session.deviceName, async () => {
    local.flush();
    await writing;
  });
}
