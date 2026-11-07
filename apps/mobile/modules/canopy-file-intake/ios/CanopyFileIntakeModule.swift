import ExpoModulesCore

/// Files pasted into the composer (docs/mobile.md, "Wklejanie i upuszczanie").
public class CanopyFileIntakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CanopyFileIntake")

    // Copies left by an earlier run (a reload before their upload) go.
    OnCreate { IntakeFiles.clear() }

    View(CanopyPasteView.self) {
      Events("onFiles")
      Prop("maxBytes") { (view: CanopyPasteView, bytes: Double) in view.maxBytes = Int(bytes) }
    }

  }
}
