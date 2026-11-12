import { ui } from "@canopy/contracts";
import { DiagnosticsPages, DiagnosticsEpochs } from "@canopy/domain/diagnostics";
import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

const pages = new DiagnosticsPages();
export const diagnosticsEpochs = new DiagnosticsEpochs();

export function diagnosticsOverview(key: string, range: string) {
  return new SharedRead(queries, key, async () => {
    const value = decode(ui.DiagnosticsSnapshotSchema, await requestJson("GET", `/api/diagnostics?range=${range}`));

    if (value.computers.some((computer) => !diagnosticsEpochs.accept(computer)))
      throw new Error("Diagnostics baseline changed; refresh again");

    return value;
  });
}

export function diagnosticsRead(
  key: string,
  computer: string,
  range: string,
  offset: number,
  sort: string,
  kind: string,
) {
  return new SharedRead(queries, key, async () => {
    const params = new URLSearchParams({ computer, range, offset: String(offset), sort, kind });

    for (const method of pages.keys.get(key) ?? []) params.append("method", method);

    const value = decode(ui.ComputerDiagnosticsSchema, await requestJson("GET", `/api/diagnostics?${params}`));

    if (!diagnosticsEpochs.accept(value)) throw new Error("Diagnostics baseline changed; refresh again");

    return pages.remember(key, value);
  });
}
