import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

/** A home's current resource timestamps move to the receiving gateway's clock exactly once. */
export function receiveStorage(value: ui.ComputerDiagnostics, receivedAt = Date.now()) {
  const translate = (storage: ui.DiagnosticsStorage | undefined) => {
    if (!storage || !storage.sampledAtMs) return storage;

    return create(ui.DiagnosticsStorageSchema, {
      ...storage,
      sampledAtMs: BigInt(Math.max(1, Math.trunc(receivedAt - storage.sampleAgeMs))),
    });
  };

  value.storage = translate(value.storage);

  for (const link of value.links) link.storage = translate(link.storage);

  return value;
}

/** Advance only current storage ages, using the receiver's monotonic cache residence time. */
export function advanceStorage(value: ui.ComputerDiagnostics, elapsed: number) {
  const age = (storage: ui.DiagnosticsStorage | undefined) =>
    storage &&
    create(ui.DiagnosticsStorageSchema, {
      ...storage,
      sampleAgeMs: storage.sampledAtMs ? storage.sampleAgeMs + Math.max(0, elapsed) : 0,
    });

  return create(ui.ComputerDiagnosticsSchema, {
    ...value,
    storage: age(value.storage),
    links: value.links.map((link) => create(ui.DiagnosticsLinkSchema, { ...link, storage: age(link.storage) })),
  });
}
