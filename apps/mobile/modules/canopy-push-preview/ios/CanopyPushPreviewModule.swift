import ExpoModulesCore
import Foundation
import Security

public class CanopyPushPreviewModule: Module {
  private static let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("CanopyPushPreview")

    AsyncFunction("getOrCreateKey") { (deviceId: String) -> String in
      try Self.lock.withLock {
        if let current = try PushPreviewKeychain.read(), current.deviceId == deviceId {
          return PushPreviewBase64.encode(current.key)
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw PushPreviewKeychain.StorageError.keychain(status) }

        let key = Data(bytes)
        try PushPreviewKeychain.write(.init(deviceId: deviceId, key: key))
        return PushPreviewBase64.encode(key)
      }
    }

    AsyncFunction("clearKey") {
      try Self.lock.withLock { try PushPreviewKeychain.clear() }
    }
  }
}
