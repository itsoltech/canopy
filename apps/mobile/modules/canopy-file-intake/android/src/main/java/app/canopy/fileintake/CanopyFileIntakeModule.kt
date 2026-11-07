package app.canopy.fileintake

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CanopyFileIntakeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CanopyFileIntake")

    // Copies left by an earlier run (a reload before their upload) go.
    OnCreate { appContext.reactContext?.let { IntakeFiles(it).clear() } }

    View(CanopyPasteView::class) {
      Name("CanopyPasteView")
      Events("onFiles")
      Prop("maxBytes") { view: CanopyPasteView, bytes: Double -> view.maxBytes = bytes.toLong() }
    }

  }
}
