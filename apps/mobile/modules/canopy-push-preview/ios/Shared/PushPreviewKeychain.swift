import Foundation
import Security

enum PushPreviewKeychain {
  struct Entry: Codable {
    let deviceId: String
    let key: Data
  }

  enum StorageError: Error {
    case missingAccessGroup
    case keychain(OSStatus)
  }

  static func read() throws -> Entry? {
    var query = try itemQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw StorageError.keychain(status) }
    guard let data = result as? Data,
          let entry = try? JSONDecoder().decode(Entry.self, from: data),
          entry.key.count == 32 else { return nil }
    return entry
  }

  static func write(_ entry: Entry) throws {
    let query = try itemQuery()
    let attributes: [String: Any] = [
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData as String: try JSONEncoder().encode(entry)
    ]

    // Replace the device ID and key together, including when switching to a new pairing.
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let item = query.merging(attributes) { _, updated in updated }
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw StorageError.keychain(status) }
  }

  static func clear() throws {
    let status = SecItemDelete(try itemQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError.keychain(status) }
  }

  private static func itemQuery() throws -> [String: Any] {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "CanopyPushPreviewKeychainGroup") as? String,
          !group.isEmpty, !group.contains("$") else { throw StorageError.missingAccessGroup }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app.canopy.push-preview.v1",
      kSecAttrAccount as String: "current",
      kSecAttrAccessGroup as String: group,
      kSecAttrSynchronizable as String: false
    ]
  }
}
