import { useState } from "react";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import timeZones from "@canopy/ui/timezones";
import { Button, Field, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { ScheduleDate } from "./ScheduleDate";

export function ScheduleRecurrence({
  cron,
  setCron,
  timezone,
  setTimezone,
  until,
  setUntil,
  maxRuns,
  setMaxRuns,
}: {
  cron: string;
  setCron: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  until: string;
  setUntil: (v: string) => void;
  maxRuns: number;
  setMaxRuns: (v: number) => void;
}) {
  const resource = useSettingsResource("schedule-preview", (api) => api.listSchedules({}));
  const [preview, setPreview] = useState<ui.PreviewScheduleResponse>();
  const [ends, setEnds] = useState(until ? "until" : maxRuns ? "count" : "never");
  const zones = [...new Set([timezone, "UTC", ...timeZones])];

  return (
    <ResourceState resource={resource}>
      <SchedulePattern
        cron={cron}
        onChange={(value) => {
          setCron(value);
          setPreview(undefined);
        }}
      />
      <SettingChoice
        title="Time zone"
        value={timezone}
        search="Search time zones"
        options={zones.map((value) => ({ value, label: value }))}
        onChange={(value) => {
          setTimezone(value);
          setPreview(undefined);
        }}
      />
      <SettingChoice
        title="Ends"
        value={ends}
        options={[
          { value: "never", label: "Never" },
          { value: "until", label: "On a date" },
          { value: "count", label: "After a number of runs" },
        ]}
        onChange={(value) => {
          setEnds(value);
          setUntil(value === "until" ? until || new Date(Date.now() + 7 * 86400000).toISOString() : "");
          setMaxRuns(value === "count" ? Math.max(1, maxRuns) : 0);
        }}
      />
      {ends === "until" && <ScheduleDate title="End date" value={until} onChange={setUntil} />}
      {ends === "count" && (
        <Field
          label="Runs"
          value={String(maxRuns)}
          keyboardType="number-pad"
          onChangeText={(value) => setMaxRuns(Math.max(1, Math.floor(Number(value)) || 1))}
        />
      )}
      {cron && (
        <Notice>
          {cron} in {timezone}. Runs at least 5 minutes apart.
        </Notice>
      )}
      <Button
        title="Preview occurrences"
        busy={resource.busy}
        disabled={!cron || !timezone}
        onPress={() =>
          void resource
            .run((api) => api.previewSchedule({ cron, timezone, count: 5 }))
            .then((r) => {
              if (r) setPreview(r);
            })
        }
      />
      {preview?.nextRuns.map((value, index) => (
        <Notice key={index}>{timestampDate(value).toLocaleString()}</Notice>
      ))}
    </ResourceState>
  );
}

function initialPattern(cron: string) {
  const [minute = "0", hour = "9", day, month, weekday = "1"] = cron.split(" ");
  const simple = /^\d+$/.test(minute) && day === "*" && month === "*";

  const frequency = !simple
    ? "custom"
    : hour === "*" && weekday === "*"
      ? "hourly"
      : !/^\d+$/.test(hour)
        ? "custom"
        : weekday === "*"
          ? "daily"
          : weekday === "1-5"
            ? "weekdays"
            : /^[0-6]$/.test(weekday)
              ? "weekly"
              : "custom";

  const safeMinute = /^\d{1,2}$/.test(minute) && Number(minute) < 60 ? minute : "0";
  const safeHour = /^\d{1,2}$/.test(hour) && Number(hour) < 24 ? hour : "9";

  return {
    frequency,
    minute: safeMinute,
    time: `${safeHour.padStart(2, "0")}:${safeMinute.padStart(2, "0")}`,
    weekday: /^[0-6]$/.test(weekday) ? weekday : "1",
  };
}

type Pattern = ReturnType<typeof initialPattern>;

function expression(value: Pattern) {
  if (value.frequency === "hourly")
    return /^\d{1,2}$/.test(value.minute) && Number(value.minute) < 60 ? `${Number(value.minute)} * * * *` : "";
  const time = /^(\d{1,2}):(\d{2})$/.exec(value.time);

  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return "";

  return `${Number(time[2])} ${Number(time[1])} * * ${value.frequency === "weekdays" ? "1-5" : value.frequency === "weekly" ? value.weekday : "*"}`;
}

function SchedulePattern({ cron, onChange }: { cron: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(() => initialPattern(cron));

  const change = (patch: Partial<Pattern>) => {
    const next = { ...value, ...patch };
    setValue(next);
    onChange(next.frequency === "custom" ? cron || "0 9 * * *" : expression(next));
  };

  return (
    <>
      <SettingChoice
        title="How often"
        value={value.frequency}
        onChange={(frequency) => change({ frequency })}
        options={[
          { value: "hourly", label: "Every hour" },
          { value: "daily", label: "Every day" },
          { value: "weekdays", label: "Weekdays" },
          { value: "weekly", label: "Every week" },
          { value: "custom", label: "Custom (cron)" },
        ]}
      />
      {value.frequency === "custom" ? (
        <Field label="Cron" value={cron} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} />
      ) : value.frequency === "hourly" ? (
        <Field
          label="At minute"
          value={value.minute}
          onChangeText={(minute) => change({ minute })}
          keyboardType="number-pad"
          maxLength={2}
        />
      ) : (
        <Field
          label="At"
          value={value.time}
          onChangeText={(time) => change({ time })}
          placeholder="09:00"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
        />
      )}
      {value.frequency === "weekly" && (
        <SettingChoice
          title="On"
          value={value.weekday}
          onChange={(weekday) => change({ weekday })}
          options={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
            (label, index) => ({ value: String(index), label }),
          )}
        />
      )}
    </>
  );
}
