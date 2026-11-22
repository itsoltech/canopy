import CryptoKit
import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private struct Preview: Decodable {
    let title: String
    let body: String
  }

  private let lock = NSLock()
  private var deliver: ((UNNotificationContent?) -> Void)?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    lock.withLock {
      deliver = { contentHandler($0 ?? request.content) }
    }

    // Expo forwards its custom data in APNs userInfo["body"]. The original alert is generic.
    guard let data = request.content.userInfo["body"] as? [String: Any],
          let preview = try? Self.decrypt(data),
          let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      finish(nil)
      return
    }
    content.title = preview.title
    content.body = preview.body
    finish(content)
  }

  override func serviceExtensionTimeWillExpire() {
    finish(nil)
  }

  private func finish(_ content: UNNotificationContent?) {
    let handler = lock.withLock {
      let handler = deliver
      deliver = nil
      return handler
    }
    handler?(content)
  }

  private static func decrypt(_ data: [String: Any]) throws -> Preview? {
    guard let receiptId = data["receiptId"] as? String, UUID(uuidString: receiptId) != nil,
          let envelope = data["preview"] as? String,
          let combined = PushPreviewBase64.decode(envelope),
          let key = try PushPreviewKeychain.read()?.key else { return nil }

    // CryptoKit interprets the combined format as nonce (12 bytes) || ciphertext || tag (16 bytes).
    let box = try AES.GCM.SealedBox(combined: combined)
    let aad = Data("canopy-push-preview-v1:\(receiptId)".utf8)
    let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    return try JSONDecoder().decode(Preview.self, from: plaintext)
  }
}
