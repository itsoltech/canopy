<script lang="ts">
  import { str } from "#lib/shared/format.ts";
  import FileDiffEntry from "../FileDiffEntry.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { parsePatch, replacementDiff } from "./parse.ts";
  import ResultText from "./ResultText.svelte";

  /**
   * File edits that arrive as tool calls (Write, Edit, MultiEdit, NotebookEdit, Codex apply_patch): each file
   * with its diff, as file changes show. The result is shown only when it failed (otherwise it just says
   * the file was updated).
   */
  let { call, input, status, streaming }: ToolBodyProps = $props();

  const files = $derived.by(() => {
    if (call.name === "apply_patch") return parsePatch(str(input["input"]) || str(input["patch"]));
    const path = str(input["file_path"]) || str(input["notebook_path"]);
    if (call.name === "Write") return [{ path, kind: "add", movePath: "", diff: replacementDiff("", str(input["content"])) }];
    if (call.name === "NotebookEdit") return [{ path, kind: "update", movePath: "", diff: replacementDiff("", str(input["new_source"])) }];
    const edits = Array.isArray(input["edits"]) ? (input["edits"] as Record<string, unknown>[]) : [input];
    const diff = edits.map((edit) => replacementDiff(str(edit?.["old_string"]), str(edit?.["new_string"]))).join("\n");
    return [{ path, kind: "update", movePath: "", diff }];
  });
</script>

{#each files as file, index (index)}
  <FileDiffEntry path={file.path} kind={file.kind} movePath={file.movePath} diff={file.diff} />
{/each}
{#if call.isError || files.length === 0}
  <ResultText {call} {status} {streaming} />
{/if}
