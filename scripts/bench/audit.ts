import { sqlInventory } from "./sql-inventory.ts";
import { parseArgs } from "node:util";
import { auditEvidence, type AuditEvidence } from "./audit-evidence.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "benchmark-directory": { type: "string" },
    "integration-directory": { type: "string" },
  },
});

const directories: { path: string; kind: AuditEvidence["kind"] }[] = [];

if (values["benchmark-directory"]) directories.push({ path: values["benchmark-directory"], kind: "benchmark" });

if (values["integration-directory"]) directories.push({ path: values["integration-directory"], kind: "integration" });

const { matched, ...summary } = await auditEvidence(directories);

const entries = (await sqlInventory()).map(({ template: _template, ...entry }) => ({
  ...entry,
  evidence: matched.get(`${entry.file}:${entry.line}`) ?? [],
}));

console.log(
  JSON.stringify(
    {
      note: "Static review candidates, not confirmed defects. Fragments may overlap; dynamically assembled SQL requires source review. No values or SQL text are emitted.",
      evidenceNote:
        "Evidence matches SQL templates, not executed call sites. Integration fixtures do not establish large-dataset performance. Unmatched locations remain unchecked; DDL and session side effects require separate review. Files must describe the same source revision; line numbers are not stable across edits.",
      summary: {
        ...summary,
        locations: entries.length,
        matchedLocations: entries.filter((entry) => entry.evidence.length).length,
        locationsWithoutEvidence: entries.filter((entry) => !entry.evidence.length).length,
      },
      entries,
    },
    null,
    2,
  ),
);
