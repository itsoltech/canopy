import { ui } from "@canopy/contracts";
import { DiagnosticsPages } from "@canopy/domain/diagnostics";
import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

const pages = new DiagnosticsPages();

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

    return pages.remember(
      key,
      decode(ui.ComputerDiagnosticsSchema, await requestJson("GET", `/api/diagnostics?${params}`)),
    );
  });
}
