import Foundation

enum PushPreviewBase64 {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ value: String) -> Data? {
    guard value.utf8.allSatisfy({ byte in
      switch byte {
      case 45, 48...57, 65...90, 95, 97...122: return true
      default: return false
      }
    }) else { return nil }

    let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padding = (4 - padded.utf8.count % 4) % 4
    return Data(base64Encoded: padded + String(repeating: "=", count: padding))
  }
}
