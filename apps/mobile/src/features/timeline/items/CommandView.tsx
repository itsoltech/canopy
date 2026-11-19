import { Text } from "react-native";
import { ItemStatus, type CommandExecution } from "@canopy/contracts";
import { streamingText } from "@canopy/ui/streaming";
import { formatDuration } from "@canopy/domain/format";
import { Badge } from "../../../ui/Badge";
import { useColors, useTypography } from "../../../ui/theme";
import { CodeBlock, OutputBlock } from "../CodeBlock";
import { ItemFrame } from "../ItemFrame";
import { Aside, RowTitle } from "./parts";

/** Shell command: command line, exit code, duration; the output opens under it (web: CommandView). */
export function CommandView({
  command,
  status,
  streaming,
}: {
  command: CommandExecution;
  status: ItemStatus;
  streaming: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const first = command.command.split("\n")[0] ?? "";

  return (
    <ItemFrame
      icon="command-line"
      status={status}
      label={`Command ${first}`}
      title={<RowTitle subject={first} mono />}
      aside={
        <>
          {command.durationMs > 0n && <Aside>{formatDuration(command.durationMs)}</Aside>}
          {command.exitCode !== undefined && (
            <Badge tone={command.exitCode === 0 ? "emerald" : "rose"}>exit {command.exitCode}</Badge>
          )}
        </>
      }
    >
      <CodeBlock text={command.command} label="Command" />
      {command.cwd ? (
        <Text numberOfLines={1} style={[type.mono, { fontSize: 12, lineHeight: 20, color: c.muted }]}>
          in {command.cwd}
        </Text>
      ) : null}
      <OutputBlock
        output={streamingText(command.output, streaming)}
        blob={command.outputBlob}
        label={`Output of ${first}`}
        empty={status === ItemStatus.IN_PROGRESS ? "Waiting for output…" : "No output."}
      />
    </ItemFrame>
  );
}
