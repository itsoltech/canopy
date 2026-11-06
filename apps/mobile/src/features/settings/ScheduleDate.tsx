import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, Field, IconButton, Sheet } from "../../ui/components";
import { SelectField } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";
import { SettingsActions } from "./SettingsGroup";

export function ScheduleDate({
  title,
  value,
  onChange,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const [day, setDay] = useState(new Date());
  const [month, setMonth] = useState(new Date());
  const [time, setTime] = useState("09:00");
  const parts = /^(\d{1,2}):(\d{2})$/.exec(time);
  const hour = Number(parts?.[1] ?? NaN);
  const minute = Number(parts?.[2] ?? NaN);
  const date = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);

  const valid =
    hour >= 0 &&
    hour < 24 &&
    minute >= 0 &&
    minute < 60 &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getTime() > openedAt;

  return (
    <View style={{ gap: 8 }}>
      <SelectField
        label={title}
        value={value ? new Date(value).toLocaleString() : "Choose date and time"}
        onPress={() => {
          setOpenedAt(Date.now());
          const initial = value ? new Date(value) : new Date(Date.now() + 3600000);
          setDay(initial);
          setMonth(new Date(initial.getFullYear(), initial.getMonth(), 1));
          setTime(`${String(initial.getHours()).padStart(2, "0")}:${String(initial.getMinutes()).padStart(2, "0")}`);
          setOpen(true);
        }}
      />
      <Text style={[styles.workMeta, { color: c.muted }]}>
        In your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
      </Text>
      <Sheet title={title} visible={open} onClose={() => setOpen(false)}>
        <View style={{ width: "100%", maxWidth: 420, alignSelf: "center", gap: 16 }}>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <IconButton
              icon="chevron-left"
              label="Previous month"
              onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            />
            <Text accessibilityRole="header" style={[styles.chrome, { color: c.text }]}>
              {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </Text>
            <IconButton
              icon="chevron-right"
              label="Next month"
              onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            />
          </View>
          <Calendar month={month} selected={day} onSelect={setDay} />
          <Field
            label="Time (24-hour)"
            value={time}
            onChangeText={setTime}
            placeholder="09:00"
            keyboardType="numbers-and-punctuation"
            maxLength={5}
          />
          <SettingsActions>
            <Button
              title="Choose date"
              disabled={!valid}
              onPress={() => {
                if (date.getTime() <= Date.now()) {
                  setOpenedAt(Date.now());

                  return;
                }

                onChange(date.toISOString());
                setOpen(false);
              }}
            />
          </SettingsActions>
        </View>
      </Sheet>
    </View>
  );
}

function Calendar({ month, selected, onSelect }: { month: Date; selected: Date; onSelect: (day: Date) => void }) {
  const c = useColors();
  const year = month.getFullYear();
  const index = month.getMonth();
  const first = new Date(year, index, 1).getDay();
  const count = new Date(year, index + 1, 0).getDate();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      {Array.from({ length: 7 }, (_, day) => (
        <Text
          key={`weekday-${day}`}
          style={[styles.workMeta, { width: "14.2857%", textAlign: "center", color: c.muted, paddingVertical: 8 }]}
        >
          {new Date(2026, 10, 1 + day).toLocaleDateString(undefined, { weekday: "short" })}
        </Text>
      ))}
      {Array.from({ length: Math.ceil((first + count) / 7) * 7 }, (_, cell) => {
        const number = cell - first + 1;
        const date = new Date(year, index, number);
        const shown = number > 0 && number <= count;
        const checked = shown && date.toDateString() === selected.toDateString();
        const disabled = date < today;

        return (
          <View key={cell} style={{ width: "14.2857%", padding: 2 }}>
            {shown && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={date.toLocaleDateString(undefined, { dateStyle: "full" })}
                accessibilityState={{ selected: checked, disabled }}
                disabled={disabled}
                onPress={() => onSelect(date)}
                style={{
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 8,
                  backgroundColor: checked ? c.action : "transparent",
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                <Text style={[styles.chrome, { color: checked ? c.onControl : c.text }]}>{number}</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}
