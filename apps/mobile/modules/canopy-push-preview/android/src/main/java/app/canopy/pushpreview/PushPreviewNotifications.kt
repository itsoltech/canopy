package app.canopy.pushpreview

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationAction
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.NotificationResponse
import expo.modules.notifications.notifications.presentation.builders.ExpoNotificationBuilder
import expo.modules.notifications.service.NotificationsService
import org.json.JSONObject

internal object PushPreviewNotifications {
  private const val CHANNEL = "canopy-updates"
  private const val TAG_PREFIX = "canopy-push:"
  private val generic = PushPreview("Canopy", "You have a new update.")

  fun post(context: Context, receiptId: String, preview: PushPreview?) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (!manager.areNotificationsEnabled()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Canopy updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
          lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
          setShowBadge(true)
        }
      )
    }

    val identifier = TAG_PREFIX + receiptId
    // Expo's response pipeline handles warm and cold taps. Only the receipt goes in its intent.
    val content = NotificationContent.Builder().setBody(JSONObject().put("receiptId", receiptId)).build()
    val response = Notification(NotificationRequest(identifier, content, null))
    val action = NotificationAction(NotificationResponse.DEFAULT_ACTION_IDENTIFIER, null, true)
    val tap = NotificationsService.createNotificationResponseIntent(context, response, action)
    val app = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    val icon = app.metaData?.getInt(ExpoNotificationBuilder.META_DATA_DEFAULT_ICON_KEY, app.icon) ?: app.icon
    val notification = builder(context, preview ?: generic, icon)
      .setNumber(1)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setDefaults(NotificationCompat.DEFAULT_SOUND)
      .setContentIntent(tap)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(builder(context, generic, icon).build())
      .build()
    manager.notify(identifier, 0, notification)
  }

  fun dismiss(context: Context, receiptIds: List<String>) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (receiptId in receiptIds) manager.cancel(TAG_PREFIX + receiptId, 0)
  }

  fun cancel(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (notification in manager.activeNotifications) {
      if (notification.tag?.startsWith(TAG_PREFIX) == true) {
        manager.cancel(notification.tag, notification.id)
      }
    }
  }

  private fun builder(context: Context, preview: PushPreview, icon: Int) =
    NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle(preview.title)
      .setContentText(preview.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(preview.body))
}
