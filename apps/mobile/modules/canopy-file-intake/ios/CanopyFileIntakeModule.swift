import ExpoModulesCore

/// Files pasted into the composer or dropped on a thread from other apps (docs/mobile.md, "Wklejanie i upuszczanie").
public class CanopyFileIntakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CanopyFileIntake")

    // Copies left by an earlier run (a reload before their upload) go.
    OnCreate { IntakeFiles.clear() }

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
