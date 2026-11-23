import AppKit

let application = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let expectedName = CommandLine.arguments[2]
let artwork = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
guard let bundle = Bundle(url: application),
      bundle.bundleIdentifier == "app.canopy.desktop",
      bundle.executableURL?.lastPathComponent == "canopy",
      bundle.infoDictionary?["CFBundleName"] as? String == "Canopy",
      bundle.localizedInfoDictionary?["CFBundleDisplayName"] as? String == expectedName,
      let iconFile = bundle.infoDictionary?["CFBundleIconFile"] as? String,
      let resources = bundle.resourceURL else {
    fatalError("Invalid Canopy bundle identity or localized display name at \(application.path)")
}

let finderName = FileManager.default.displayName(atPath: application.path)
guard finderName == expectedName || finderName == "\(expectedName).app" else {
    fatalError("Finder resolved '\(finderName)' for \(application.path), expected '\(expectedName)'")
}

for (file, source) in [(iconFile, "icon.icns"), ("icon.png", "icon-512.png")] {
    let icon = resources.appendingPathComponent(file)
    let expected = try Data(contentsOf: artwork.appendingPathComponent(source))
    let installed = try Data(contentsOf: icon)
    guard installed == expected, NSImage(contentsOf: icon)?.isValid == true else {
        fatalError("Incorrect or unreadable channel artwork at \(icon.path)")
    }
}
