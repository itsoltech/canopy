import Foundation
import UniformTypeIdentifiers

/// Files from a paste or a drop, copied into `tmp/canopy-intake` where the attachment upload reads them (and
/// deletes them). A file over `maxBytes` is not copied, only reported with its size, so the composer says why.
enum IntakeFiles {
  static let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "canopy-intake", isDirectory: true)

  static func clear() {
    try? FileManager.default.removeItem(at: directory)
  }

  /// The type to load an item as: a file's own type. Bare text, links and rich text are not files, unless the item
  /// is a named file (a .txt from Files).
  static func fileType(_ provider: NSItemProvider) -> String? {
    let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
    let textual: [UTType] = [.text, .url, .rtf, .html]
    let file = types.first { type in type.conforms(to: .data) && !textual.contains { type.conforms(to: $0) } }

    if let file { return file.identifier }
    guard provider.suggestedName != nil else { return nil }

    return types.first { $0.conforms(to: .data) }?.identifier
  }

  static func carriesFiles(_ providers: [NSItemProvider]) -> Bool {
    providers.contains { fileType($0) != nil }
  }

  /// Copies each item that is a file; `done` runs on the main queue with the files in their order.
  static func load(_ providers: [NSItemProvider], maxBytes: Int, done: @escaping ([[String: Any]]) -> Void) {
    let group = DispatchGroup()
    let lock = NSLock()
    var results: [Int: [String: Any]] = [:]

    for (index, provider) in providers.enumerated() {
      guard let type = fileType(provider) else { continue }
      group.enter()
      // The file exists only during the callback: copy it there.
      provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
        defer { group.leave() }
        guard let url, let entry = copy(url, provider: provider, type: type, maxBytes: maxBytes) else { return }
        lock.lock()
        results[index] = entry
        lock.unlock()
      }
    }

    group.notify(queue: .main) { done(results.keys.sorted().compactMap { results[$0] }) }
  }

  private static func copy(_ source: URL, provider: NSItemProvider, type: String, maxBytes: Int) -> [String: Any]? {
    let name = fileName(provider.suggestedName ?? source.lastPathComponent, type: UTType(type))
    let mimeType = UTType(type)?.preferredMIMEType ?? "application/octet-stream"
    let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0

    guard size <= maxBytes else { return ["name": name, "size": size, "mimeType": mimeType] }
    let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let target = folder.appendingPathComponent(name)

    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: source, to: target)
    } catch {
      return nil
    }

    return ["uri": target.absoluteString, "name": name, "size": size, "mimeType": mimeType]
  }

  private static func fileName(_ raw: String, type: UTType?) -> String {
    let base = (raw as NSString).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
    let stem = base.isEmpty || base == "." || base == ".." ? (type?.conforms(to: .image) == true
      ? "pasted-image" : "pasted-file") : base

    guard (stem as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension else { return stem }

    return "\(stem).\(ext)"
  }
}
