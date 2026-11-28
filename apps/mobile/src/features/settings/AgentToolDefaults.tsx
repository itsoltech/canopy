import { useState } from "react";
import { Text, View } from "react-native";
import { create, equals } from "@bufbuild/protobuf";
import { AgentTool, AgentToolSessionDefaultsSchema, type AgentToolSessionDefaults } from "@canopy/contracts";
import { devicePlatforms, pageAppearances, sessionDefaults, viewportSizes } from "@canopy/domain/agent-tool-settings";
import { useAppearance } from "../../state/appearance";
import { Button, Field } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { SettingChoice, SettingToggle, SettingsActions } from "./SettingsGroup";

function formValues(defaults: AgentToolSessionDefaults) {
  const browser = defaults.browser;
  const width = String(browser?.viewportWidth ?? "");
  const height = String(browser?.viewportHeight ?? "");
  const size = width || height ? `${width}x${height}` : "";

  return {
    viewport: viewportSizes.some((option) => option.value === size) ? size : "custom",
    width,
    height,
    scheme: browser?.colorScheme ?? "",
    app: defaults.desktop?.app ?? "",
    allowPhysicalInput: defaults.desktop?.allowPhysicalInput ?? false,
    platform: defaults.device?.platform ?? "",
    allowBoot: defaults.device?.allowBoot ?? true,
    timeout: String(defaults.device?.acquireTimeoutSeconds ?? ""),
  };
}

type FormValues = ReturnType<typeof formValues>;

function inputValue(tool: AgentTool, values: FormValues) {
  if (tool === AgentTool.BROWSER) {
    const dimensions = values.viewport === "custom" ? [values.width, values.height] : values.viewport.split("x");

    if (values.viewport && !dimensions.every((n) => /^\d+$/.test(n) && Number(n) >= 320 && Number(n) <= 8192))
      return { error: "Enter a width and height from 320 to 8192 pixels." };

    return {
      value: create(AgentToolSessionDefaultsSchema, {
        browser: {
          colorScheme: values.scheme,
          ...(values.viewport && { viewportWidth: Number(dimensions[0]), viewportHeight: Number(dimensions[1]) }),
        },
      }),
    };
  }

  if (tool === AgentTool.DESKTOP)
    return {
      value: create(AgentToolSessionDefaultsSchema, {
        desktop: { app: values.app.trim(), allowPhysicalInput: values.allowPhysicalInput },
      }),
    };

  if (values.timeout && (!/^\d+$/.test(values.timeout) || Number(values.timeout) < 1 || Number(values.timeout) > 240))
    return { error: "Enter a device wait from 1 to 240 seconds." };

  return {
    value: create(AgentToolSessionDefaultsSchema, {
      device: {
        platform: values.platform,
        ...(!values.allowBoot && { allowBoot: false }),
        ...(values.timeout && { acquireTimeoutSeconds: Number(values.timeout) }),
      },
    }),
  };
}

export function AgentToolDefaults({ tool }: { tool: AgentTool }) {
  const settings = useAppearance();
  const c = useColors();
  const type = useTypography();
  const saved = sessionDefaults(settings.user?.agentToolDefaults, tool);
  const [edit, setEdit] = useState<Partial<FormValues>>({});
  const [message, setMessage] = useState("");
  const values = { ...formValues(saved), ...edit };
  const { value: next, error } = inputValue(tool, values);
  const dirty = !next || !equals(AgentToolSessionDefaultsSchema, saved, next);
  const disabled = settings.saving || !settings.user;
  const defaults = sessionDefaults(undefined, tool);

  function change(patch: Partial<FormValues>) {
    setEdit((previous) => ({ ...previous, ...patch }));
    setMessage("");
  }

  async function save() {
    if (!next || !dirty || disabled) return;
    const agentToolDefaults = create(AgentToolSessionDefaultsSchema, { ...settings.user?.agentToolDefaults, ...next });

    if (await settings.update({ agentToolDefaults })) {
      setEdit({});
      setMessage("Defaults saved");
    }
  }

  // Older gateways can manage worker grants without storing session defaults.
  if (!settings.user?.agentToolDefaults) return null;

  return (
    <View style={{ gap: 12 }}>
      <DefaultsFields tool={tool} values={values} disabled={disabled} change={change} />
      <SettingsActions>
        <Button
          title="Reset defaults"
          size="sm"
          disabled={disabled || (!!next && equals(AgentToolSessionDefaultsSchema, next, defaults))}
          onPress={() => change(formValues(defaults))}
        />
        <Button
          title="Save defaults"
          variant="primary"
          size="sm"
          disabled={disabled || !dirty || !next}
          onPress={() => void save()}
        />
      </SettingsActions>
      <Text accessibilityLiveRegion="polite" style={[type.meta, { color: error ? c.danger : c.muted, minHeight: 20 }]}>
        {error || (dirty ? "Unsaved changes" : message)}
      </Text>
    </View>
  );
}

function DefaultsFields({
  tool,
  values,
  disabled,
  change,
}: {
  tool: AgentTool;
  values: FormValues;
  disabled: boolean;
  change: (patch: Partial<FormValues>) => void;
}) {
  return (
    <>
      {tool === AgentTool.BROWSER && (
        <>
          <SettingChoice
            title="Viewport size"
            value={values.viewport}
            options={viewportSizes}
            disabled={disabled}
            onChange={(viewport) => {
              if (viewport === "custom") change({ viewport });
              else {
                const [width = "", height = ""] = viewport.split("x");
                change({ viewport, width, height });
              }
            }}
          />
          {values.viewport === "custom" && (
            <>
              <Field
                label="Width (px)"
                value={values.width}
                editable={!disabled}
                keyboardType="number-pad"
                onChangeText={(width) => change({ viewport: "custom", width })}
              />
              <Field
                label="Height (px)"
                value={values.height}
                editable={!disabled}
                keyboardType="number-pad"
                onChangeText={(height) => change({ viewport: "custom", height })}
              />
            </>
          )}
          <SettingChoice
            title="Page appearance"
            description="The color scheme requested from websites."
            value={values.scheme}
            options={pageAppearances}
            disabled={disabled}
            onChange={(scheme) => change({ scheme })}
          />
        </>
      )}
      {tool === AgentTool.DESKTOP && (
        <>
          <Field
            label="Default app"
            placeholder="Safari"
            value={values.app}
            maxLength={200}
            editable={!disabled}
            onChangeText={(app) => change({ app })}
          />
          <SettingToggle
            title="Allow physical input"
            description="In later turns, Agent Desktop can move your pointer, change window focus and send keystrokes on workers where it’s enabled."
            value={values.allowPhysicalInput}
            disabled={disabled}
            onChange={(allowPhysicalInput) => change({ allowPhysicalInput })}
          />
        </>
      )}
      {tool === AgentTool.DEVICE && (
        <>
          <SettingChoice
            title="Preferred platform"
            value={values.platform}
            options={devicePlatforms}
            disabled={disabled}
            onChange={(platform) => change({ platform })}
          />
          <Field
            label="Device wait (seconds)"
            placeholder="60"
            value={values.timeout}
            keyboardType="number-pad"
            editable={!disabled}
            onChangeText={(timeout) => change({ timeout })}
          />
          <SettingToggle
            title="Start emulators"
            description="Allow the agent to start a configured emulator or simulator."
            value={values.allowBoot}
            disabled={disabled}
            onChange={(allowBoot) => change({ allowBoot })}
          />
        </>
      )}
    </>
  );
}
