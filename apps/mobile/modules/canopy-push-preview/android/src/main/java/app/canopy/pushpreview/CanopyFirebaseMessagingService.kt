package app.canopy.pushpreview

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.notifications.model.NotificationData
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.delegates.ExpoHandlingDelegate

class CanopyFirebaseMessagingService : ExpoFirebaseMessagingService() {
  private val expoHandling by lazy { ExpoHandlingDelegate(this) }
  private val receiptPattern = Regex(
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    RegexOption.IGNORE_CASE
  )

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val data = if (remoteMessage.notification == null) NotificationData(remoteMessage.data).body else null
    val receiptId = (data?.opt("receiptId") as? String)?.takeIf(receiptPattern::matches)
    if (data == null || receiptId == null) {
      super.onMessageReceived(remoteMessage)
      return
    }
    if (expoHandling.isAppInForeground()) return

    // Clearing or rotating the key also removes displayed previews. Keep decrypt and post together.
    synchronized(PushPreviewKeys) {
      val encoded = data.opt("preview") as? String
      val preview = encoded?.let { decrypt(receiptId, it) }
      if (!expoHandling.isAppInForeground()) PushPreviewNotifications.post(this, receiptId, preview)
    }
  }

  private fun decrypt(receiptId: String, encoded: String): PushPreview? {
    return try {
      val raw = PushPreviewKeys.load(this) ?: return null
      try {
        PushPreviewCrypto.decryptPreview(raw, receiptId, encoded)
      } finally {
        raw.fill(0)
      }
    } catch (_: Exception) {
      null
    }
  }
}
