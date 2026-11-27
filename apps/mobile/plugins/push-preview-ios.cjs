const { copyFile, mkdir, writeFile } = require("node:fs/promises");
const { basename, join } = require("node:path");
const { IOSConfig, withXcodeProject } = require("expo/config-plugins");

const targetName = "CanopyPushPreviewService";
const keychainGroups = "keychain-access-groups";

const sources = [
  "Extension/NotificationService.swift",
  "Shared/PushPreviewBase64.swift",
  "Shared/PushPreviewKeychain.swift",
];

/** @type {import("expo/config-plugins").ConfigPlugin} */
module.exports = (config) => {
  const appId = config.ios?.bundleIdentifier;

  if (!appId || !/^[a-zA-Z0-9.-]+$/.test(appId)) {
    throw new Error("Encrypted push previews require an iOS bundle identifier.");
  }

  const bundleIdentifier = `${appId}.push-preview`;
  const group = `$(AppIdentifierPrefix)${bundleIdentifier}`;
  const entitlements = { [keychainGroups]: [group] };

  // Silent dismissals wake the app in the background to remove alerts read on another device.
  const backgroundModes = config.ios.infoPlist?.UIBackgroundModes ?? [];
  config.ios.infoPlist = {
    ...config.ios.infoPlist,
    CanopyPushPreviewKeychainGroup: group,
    UIBackgroundModes: [...new Set([...backgroundModes, "remote-notification"])],
  };
  // iOS adds new Keychain items to the first access group by default. Keep app credentials private.
  const appGroups = config.ios.entitlements?.[keychainGroups];
  const existingGroups = appGroups?.length ? appGroups : [`$(AppIdentifierPrefix)${appId}`];
  config.ios.entitlements = {
    ...config.ios.entitlements,
    [keychainGroups]: [...new Set([...existingGroups, group])],
  };

  // EAS resolves credentials for CNG projects before the native target exists.
  const eas = config.extra?.eas ?? {};
  const experimental = eas.build?.experimental ?? {};
  const ios = experimental.ios ?? {};
  config.extra = {
    ...config.extra,
    eas: {
      ...eas,
      build: {
        ...eas.build,
        experimental: {
          ...experimental,
          ios: {
            ...ios,
            appExtensions: [
              ...(ios.appExtensions ?? []).filter((extension) => extension.targetName !== targetName),
              { targetName, bundleIdentifier, entitlements },
            ],
          },
        },
      },
    },
  };

  return withXcodeProject(config, async (mod) => {
    const project = mod.modResults;
    const directory = join(mod.modRequest.platformProjectRoot, targetName);
    const sourceDirectory = join(mod.modRequest.projectRoot, "modules/canopy-push-preview/ios");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      ...sources.map((source) => copyFile(join(sourceDirectory, source), join(directory, basename(source)))),
      copyFile(join(sourceDirectory, "Extension/Info.plist"), join(directory, "Info.plist")),
      writeFile(
        join(directory, `${targetName}.entitlements`),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>${keychainGroups}</key>
  <array><string>${group}</string></array>
</dict></plist>
`,
      ),
    ]);

    const existing = project.findTargetKey(`"${targetName}"`);
    const target = project.pbxNativeTargetSection()[existing] ?? addExtensionTarget(project);

    for (const [, configuration] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    )) {
      Object.assign(configuration.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: "YES",
        CANOPY_PUSH_PREVIEW_KEYCHAIN_GROUP: `"${group}"`,
        CODE_SIGN_ENTITLEMENTS: `${targetName}/${targetName}.entitlements`,
        CODE_SIGN_STYLE: "Automatic",
        CURRENT_PROJECT_VERSION: IOSConfig.Version.getBuildNumber(mod),
        INFOPLIST_FILE: `${targetName}/Info.plist`,
        MARKETING_VERSION: IOSConfig.Version.getVersion(mod),
        PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
        SDKROOT: "iphoneos",
        SWIFT_VERSION: "5.0",
        TARGETED_DEVICE_FAMILY: IOSConfig.DeviceFamily.formatDeviceFamilies(
          IOSConfig.DeviceFamily.getDeviceFamilies(mod),
        ),
      });
    }

    return mod;
  });
};

function addExtensionTarget(project) {
  const app = project.getFirstTarget();
  const appPhases = app.firstTarget.buildPhases;
  const objects = project.hash.project.objects;
  // xcode only writes target dependencies when these sections already exist.
  objects.PBXContainerItemProxy ??= {};
  objects.PBXTargetDependency ??= {};

  // addTarget also creates a dependency and a copy phase that embeds the .appex in PlugIns.
  const { uuid, pbxNativeTarget } = project.addTarget(targetName, "app_extension");
  const embed = appPhases.pop();
  const copyPhases = objects.PBXCopyFilesBuildPhase;
  const copyPhase = copyPhases[embed.value];
  embed.comment = "Embed Notification Service Extension";
  copyPhase.name = `"${embed.comment}"`;
  copyPhases[`${embed.value}_comment`] = embed.comment;
  const [buildFile] = copyPhase.files;
  project.pbxBuildFileSection()[buildFile.value].settings = { ATTRIBUTES: ["RemoveHeadersOnCopy"] };
  // Embed before React Native's bundling phase to avoid a cycle during archive.
  const bundlePhase = appPhases.findIndex(({ comment }) => comment === "Bundle React Native code and images");
  appPhases.splice(bundlePhase < 0 ? appPhases.length : bundlePhase, 0, embed);

  const { uuid: group } = project.addPbxGroup([], targetName, targetName);
  project.addToPbxGroup(group, project.getFirstProject().firstProject.mainGroup);
  project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", uuid);
  const references = project.pbxFileReferenceSection();
  const product = references[pbxNativeTarget.productReference];
  delete product.fileEncoding;
  delete product.lastKnownFileType;

  for (const source of sources) {
    const file = project.addSourceFile(basename(source), { target: uuid }, group);
    // xcode writes undefined attributes as literal strings. Use the inferred Swift file type.
    delete references[file.fileRef].explicitFileType;
  }

  return pbxNativeTarget;
}
