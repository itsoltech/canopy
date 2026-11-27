import CryptoKit
import ExpoModulesCore
import UIKit
import UserNotifications

/// Handles the gateway's silent dismissal: removes delivered Canopy alerts read or settled on another device
/// and applies the encrypted badge. iOS decides whether and when the app wakes for it.
public final class PushDismissalAppDelegate: ExpoAppDelegateSubscriber {
  private struct Badge: Decodable {
    let badge: Int
  }

  private static let maxReceipts = 32

  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    // Expo forwards its custom data in APNs userInfo["body"].
    guard let data = userInfo["body"] as? [String: Any], let listed = data["dismiss"] as? [String] else {
      completionHandler(.noData)
      return
    }

    let receipts = Set(listed.prefix(Self.maxReceipts).compactMap(Self.receipt))
    let badge = Self.badge(data)
    let center = UNUserNotificationCenter.current()

    center.getDeliveredNotifications { delivered in
      let identifiers = delivered.compactMap { notification -> String? in
        let content = notification.request.content.userInfo["body"] as? [String: Any]
        guard let receipt = (content?["receiptId"] as? String).flatMap(Self.receipt),
              receipts.contains(receipt) else { return nil }
        return notification.request.identifier
      }
      if !identifiers.isEmpty { center.removeDeliveredNotifications(withIdentifiers: identifiers) }

      guard let badge else {
        completionHandler(identifiers.isEmpty ? .noData : .newData)
        return
      }
      center.setBadgeCount(badge) { _ in completionHandler(.newData) }
    }
  }

  private static func receipt(_ value: String) -> String? {
    UUID(uuidString: value)?.uuidString.lowercased()
  }

  private static func badge(_ data: [String: Any]) -> Int? {
    guard let dismissId = (data["dismissId"] as? String).flatMap(receipt),
          let envelope = data["badge"] as? String,
          let combined = PushPreviewBase64.decode(envelope),
          let key = try? PushPreviewKeychain.read()?.key,
          let box = try? AES.GCM.SealedBox(combined: combined) else { return nil }

    // A badge sealed for this dismissal only; a preview envelope uses a different label and fails here.
    let aad = Data("canopy-push-badge-v1:\(dismissId)".utf8)
    guard let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad),
          let decoded = try? JSONDecoder().decode(Badge.self, from: plaintext),
          (0...9999).contains(decoded.badge) else { return nil }
    return decoded.badge
  }
}
