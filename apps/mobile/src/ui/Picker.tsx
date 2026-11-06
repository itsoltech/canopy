import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "./Icon";
import { Overlay } from "./Overlay";
import { font, styles, useColors, useTypography, type Colors } from "./theme";
import { Skeleton } from "./Skeleton";

export interface PickerOption<T> {
  value: T;
  label: string;
  description?: string;
  icon?: IconName;
  /** Replaces the icon (provider logo, project mark). */
  leading?: ReactNode;
  /** A quiet tag after the label ("Default", "Offline"). */
  badge?: string;
  tone?: "warning" | "danger";
  disabled?: boolean;
  /** Extra words the search matches (paths, ids). */
  keywords?: string;
  /** Permission scopes must remain fully visible before the owner chooses one. */
  wrapLabel?: boolean;
}

export interface PickerSection<T> {
  title?: string;
  options: PickerOption<T>[];
}

/**
 * One picker for every choice in the app: a compact sheet (centered card on wide windows) with optional
 * search, section headers and a check on the current value. Choosing closes it. Without `value` it is an
 * action menu.
 */
export function PickerSheet<T>({
  title,
  visible,
  onClose,
  sections,
  value,
  onSelect,
  search,
  note,
  footer,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  sections: PickerSection<T>[];
  value?: T;
  onSelect: (value: T) => void;
  /** Placeholder of the search field; without it there is no search. */
  search?: string;
  note?: string;
  footer?: ReactNode;
}) {
  const c = useColors();
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();

  const shown = sections
    .map((section) => ({
      ...section,
      options: words
        ? section.options.filter((o) =>
            `${o.label} ${o.description ?? ""} ${o.badge ?? ""} ${o.keywords ?? ""} ${section.title ?? ""}`
              .toLowerCase()
              .includes(words),
          )
        : section.options,
    }))
    .filter((section) => section.options.length > 0);

  function close() {
    setQuery("");
    onClose();
  }

  return (
    <Overlay visible={visible} onClose={close} label={title}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
        <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
          {title}
        </Text>
      </View>
      {search && <SearchField value={query} onChange={setQuery} placeholder={search} />}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 4 }}
        style={{ flexGrow: 0 }}
      >
        {shown.map((section, index) => (
          <View key={section.title ?? index} accessibilityRole="list">
            {section.title ? (
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={[
                  styles.overlayHeading,
                  { color: c.muted, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2 },
                ]}
              >
                {section.title}
              </Text>
            ) : index > 0 ? (
              <View style={{ height: 1, marginVertical: 4, marginHorizontal: 8, backgroundColor: c.rule }} />
            ) : null}
            {section.options.map((option) => (
              <PickerRow
                key={String(option.value)}
                option={option}
                selected={value !== undefined && option.value === value}
                checkable={value !== undefined}
                onPress={() => {
                  close();
                  onSelect(option.value);
                }}
              />
            ))}
          </View>
        ))}
        {!shown.length && (
          <Text style={[styles.overlayMeta, { color: c.muted, padding: 12 }]}>
            {words ? `Nothing matches “${query.trim()}”.` : "Nothing to choose yet."}
          </Text>
        )}
        {note ? <Text style={[styles.overlayMeta, { color: c.muted, padding: 12 }]}>{note}</Text> : null}
      </ScrollView>
      {footer}
    </Overlay>
  );
}

function toneColor(c: Colors, tone: PickerOption<unknown>["tone"]) {
  return tone === "danger" ? c.danger : tone === "warning" ? c.warning : undefined;
}

function PickerRow<T>({
  option,
  selected,
  checkable,
  onPress,
}: {
  option: PickerOption<T>;
  selected: boolean;
  checkable: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const tone = toneColor(c, option.tone);

  return (
    <Pressable
      accessibilityRole={checkable ? "radio" : "menuitem"}
      accessibilityState={{ selected, checked: checkable ? selected : undefined, disabled: option.disabled }}
      accessibilityLabel={[option.label, option.badge, option.description].filter(Boolean).join(", ")}
      disabled={option.disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        // Web: a listbox option. Touch rows stay 44 dp; the check, not a fill, marks the choice.
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: pressed ? c.pressed : "transparent",
        opacity: option.disabled ? 0.4 : 1,
      })}
    >
      {option.leading ?? (option.icon ? <Icon name={option.icon} color={tone ?? c.icon} /> : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={[styles.row, { gap: 6 }]}>
          <Text
            numberOfLines={option.wrapLabel ? undefined : 1}
            style={[styles.overlay, { color: tone ?? c.strong, flexShrink: 1 }]}
          >
            {option.label}
          </Text>
          {option.badge ? (
            <Text numberOfLines={1} style={[styles.caption, { color: tone ?? c.faint, flexShrink: 0 }]}>
              {option.badge}
            </Text>
          ) : null}
        </View>
        {option.description ? (
          <Text numberOfLines={2} style={[styles.overlayMeta, { color: c.muted }]}>
            {option.description}
          </Text>
        ) : null}
      </View>
      {checkable && <View style={{ width: 16 }}>{selected && <Icon name="check" color={c.accent} />}</View>}
    </Pressable>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const c = useColors();

  return (
    <View
      style={[
        styles.row,
        { marginHorizontal: 16, marginVertical: 8, paddingLeft: 12, borderRadius: 10, backgroundColor: c.inset },
      ]}
    >
      <Icon name="magnifying-glass" color={c.faint} />
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        // Fields people type in stay at 16 on phones (docs/ui-scale.md).
        style={[styles.body, { flex: 1, minHeight: 44, color: c.text }]}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChange("")}
          hitSlop={4}
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="x-circle" color={c.faint} />
        </Pressable>
      ) : (
        <View style={{ width: 12 }} />
      )}
    </View>
  );
}

/** Form trigger of a picker: the label above, the current value in a field-sized row with a chevron. */
export function SelectField({
  label,
  value,
  leading,
  onPress,
  disabled,
  tone,
  hideLabel = false,
}: {
  label: string;
  value: string;
  leading?: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  tone?: PickerOption<unknown>["tone"];
  hideLabel?: boolean;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 6 }}>
      {!hideLabel && <Text style={[type.body, { fontFamily: font.medium, color: c.text }]}>{label}</Text>}
      <Skeleton>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value}`}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [
            styles.row,
            {
              minHeight: 44,
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: c.line,
              backgroundColor: disabled ? c.sidebar : pressed ? c.inset : c.surface,
            },
          ]}
        >
          {leading}
          <Text
            numberOfLines={1}
            style={[type.body, { flex: 1, color: disabled ? c.muted : (toneColor(c, tone) ?? c.text) }]}
          >
            {value}
          </Text>
          <Icon name="chevron-up-down" color={c.icon} />
        </Pressable>
      </Skeleton>
    </View>
  );
}
