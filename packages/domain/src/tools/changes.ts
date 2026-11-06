import { isJsonArray, objectOf, str, type JsonObject } from "../json.ts";
import { parsePatch, replacementDiff, type PatchFile } from "./parse.ts";

/** Shared by edit headers and their lazily mounted diff body. */
export function toolChanges(name: string, input: JsonObject): PatchFile[] {
  if (name === "apply_patch") return parsePatch(str(input["input"]) || str(input["patch"]));
  const path = str(input["file_path"]) || str(input["notebook_path"]);

  if (name === "Write") return [{ path, kind: "add", movePath: "", diff: replacementDiff("", str(input["content"])) }];

  if (name === "NotebookEdit")
    return [{ path, kind: "update", movePath: "", diff: replacementDiff("", str(input["new_source"])) }];
  const edits = isJsonArray(input["edits"]) ? input["edits"].map(objectOf) : [input];

  return [
    {
      path,
      kind: "update",
      movePath: "",
      diff: edits.map((edit) => replacementDiff(str(edit["old_string"]), str(edit["new_string"]))).join("\n"),
    },
  ];
}

export interface DiffCounts {
  readonly added: number;
  readonly removed: number;
}

export function diffCounts(diffs: readonly { diff: string }[]): DiffCounts {
  let added = 0;
  let removed = 0;

  for (const { diff } of diffs)
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }

  return { added, removed };
}
