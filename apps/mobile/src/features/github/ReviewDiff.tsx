import { useMemo, useState } from "react";
import { View } from "react-native";
import type { github } from "@canopy/contracts";
import { diffAnchors, diffRange, type DiffPoint, type DiffRange } from "@canopy/domain/diff-anchors";
import { Button, Notice, Sheet } from "../../ui/components";
import { DiffContent } from "../../ui/DiffContent";
import { diffRows } from "../../ui/diff-lines";
import { useDevicePreferences } from "../settings/device-preferences";
import { ReviewCommentComposer } from "./ReviewCommentComposer";
import type { ReviewDraft } from "./useReviewDraft";

/** Page the original numbered rows, so long patches remain bounded on phones. */
export function ReviewDiff({
  patch,
  file,
  snapshot,
  draft,
  historical,
}: {
  patch: github.PullRequestDiff;
  file: github.PullRequestFile;
  snapshot: github.PullRequestSnapshot;
  draft: ReviewDraft;
  historical: boolean;
}) {
  const { values } = useDevicePreferences();

  const rows = useMemo(
    () => diffRows(patch.patch, values.hideWhitespace === "on"),
    [patch.patch, values.hideWhitespace],
  );

  const anchors = useMemo(() => diffAnchors(patch.patch), [patch.patch]);

  const [first, setFirst] = useState<DiffPoint>(),
    [selection, setSelection] = useState<DiffRange>();

  const [extending, setExtending] = useState(false),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");

  const [page, setPage] = useState(0);

  function select(point: DiffPoint) {
    const range = diffRange(anchors, extending && first ? first : point, point);

    if (!range) {
      setError("Select a range within one diff hunk.");

      return;
    }

    if (!extending) setFirst(point);
    setSelection(range);
    setExtending(false);
    setOpen(true);
    setError("");
  }

  return (
    <View style={{ gap: 8 }}>
      {historical && <Notice>Open All commits to comment on the current changes.</Notice>}
      {extending && <Notice>Select the last line of the range.</Notice>}
      {!!error && <Notice error>{error}</Notice>}
      <DiffContent
        diff=""
        sourceRows={rows.slice(page * 100, (page + 1) * 100)}
        review={historical ? undefined : { selection, onSelect: select }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {page > 0 && <Button title="Previous diff lines" variant="ghost" onPress={() => setPage(page - 1)} />}
        {(page + 1) * 100 < rows.length && (
          <Button title="Next diff lines" variant="ghost" onPress={() => setPage(page + 1)} />
        )}
        {!!selection && <Button title="Comment on selection" variant="ghost" onPress={() => setOpen(true)} />}
      </View>
      <Sheet title="Inline comment" visible={open} onClose={() => setOpen(false)}>
        {selection && (
          <ReviewCommentComposer
            key={`${snapshot.accountId}:${file.path}:${patch.page?.headSha}`}
            snapshot={snapshot}
            file={file}
            sha={patch.page?.headSha ?? ""}
            range={selection}
            draft={draft}
            onRange={() => {
              setExtending(true);
              setOpen(false);
            }}
            onDone={() => {
              setOpen(false);
              setSelection(undefined);
            }}
          />
        )}
      </Sheet>
    </View>
  );
}
