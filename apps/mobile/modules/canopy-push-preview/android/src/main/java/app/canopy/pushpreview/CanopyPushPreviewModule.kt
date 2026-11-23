package app.canopy.pushpreview

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CanopyPushPreviewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CanopyPushPreview")

    AsyncFunction("getOrCreateKey") { deviceId: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      synchronized(PushPreviewKeys) {
        PushPreviewKeys.getOrCreateKey(context, deviceId)
      }
    }

    AsyncFunction("clearKey") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      synchronized(PushPreviewKeys) {
        PushPreviewKeys.clear(context)
      }
    }
  }
}
