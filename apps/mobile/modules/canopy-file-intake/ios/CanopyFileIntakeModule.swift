import ExpoModulesCore
import Foundation

/// Files pasted into the composer or dropped on a thread from other apps (docs/mobile.md, "Wklejanie i upuszczanie").
public class CanopyFileIntakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CanopyFileIntake")

    // Copies left by an earlier run (a reload before their upload) go.
    OnCreate { IntakeFiles.clear() }

    // Keep unsent text through cache eviction. Apply to the existing directory on upgrades too.
    Function("prepareDraftDirectory") { () throws -> String in
      let manager = FileManager.default
      guard let documents = self.appContext?.config.documentDirectory else { throw CocoaError(.fileNoSuchFile) }
      var directory = documents.appendingPathComponent("composer-drafts-v1", isDirectory: true)
      try manager.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      return directory.absoluteString
    }

    View(CanopyPasteView.self) {
      Events("onFiles")
      Prop("maxBytes") { (view: CanopyPasteView, bytes: Double) in view.maxBytes = Int(bytes) }
    }

    View(CanopyDropView.self) {
      Events("onFiles", "onDragState")
      Prop("maxBytes") { (view: CanopyDropView, bytes: Double) in view.maxBytes = Int(bytes) }
      Prop("enabled") { (view: CanopyDropView, enabled: Bool) in view.accepting = enabled }
    }
  }
}
