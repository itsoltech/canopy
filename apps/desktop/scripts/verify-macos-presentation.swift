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

let icon = resources.appendingPathComponent(iconFile)
guard NSImage(contentsOf: icon)?.isValid == true else {
    fatalError("Unreadable ICNS at \(icon.path)")
}

if artwork.lastPathComponent == "development" {
    let expected = try Data(contentsOf: artwork.appendingPathComponent("icon.icns"))
    let installed = try Data(contentsOf: icon)
    guard installed == expected else { fatalError("Incorrect Dev artwork at \(icon.path)") }
} else {
    let catalog = resources.appendingPathComponent("Assets.car")
    let data = try Data(contentsOf: catalog, options: .mappedIfSafe)
    guard bundle.infoDictionary?["CFBundleIconName"] as? String == "Icon", !data.isEmpty else {
        fatalError("Missing Icon Composer catalog at \(catalog.path)")
    }
}

let png = resources.appendingPathComponent("icon.png")
let installed = try Data(contentsOf: png)
let expected = try Data(contentsOf: artwork.appendingPathComponent("icon-512.png"))
guard installed == expected, NSImage(contentsOf: png)?.isValid == true else {
    fatalError("Incorrect or unreadable channel artwork at \(png.path)")
}
