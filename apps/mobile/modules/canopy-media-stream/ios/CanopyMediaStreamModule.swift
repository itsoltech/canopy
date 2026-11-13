import ExpoModulesCore
import Foundation
import Network

/// AVPlayer never receives a device token or a remote address. JS reads through the existing pinned client.
public class CanopyMediaStreamModule: Module {
  private let queue = DispatchQueue(label: "app.canopy.media")
  private var servers: [String: MediaListener] = [:]

  public func definition() -> ModuleDefinition {
    Name("CanopyMediaStream")
    Events("onRequest")

    AsyncFunction("open") { (promise: Promise) in
      self.queue.async {
        do {
          let server = try MediaListener(queue: self.queue, emit: { [weak self] body in self?.sendEvent("onRequest", body) })
          self.servers[server.id] = server
          server.start(promise)
        } catch { promise.reject("media_open", "Could not open video stream") }
      }
    }
    AsyncFunction("write") { (serverId: String, requestId: String, status: Int, headers: [String: String], data: Data, end: Bool, promise: Promise) in
      self.queue.async {
        guard let server = self.servers[serverId] else {
          promise.reject("media_closed", "Video stream closed")
          return
        }
        server.write(requestId, status, headers, data, end, promise)
      }
    }
    Function("close") { (id: String) in self.queue.async { self.servers.removeValue(forKey: id)?.close() } }
    OnDestroy { self.queue.async { self.servers.values.forEach { $0.close() }; self.servers.removeAll() } }
  }
}

private final class MediaListener {
  let id = UUID().uuidString
  private let path = "/" + UUID().uuidString + UUID().uuidString
  private let listener: NWListener
  private let queue: DispatchQueue
  private let emit: ([String: Any]) -> Void
  private var connections: [String: NWConnection] = [:]
  private var reading = Set<String>()
  private var lastActivity = Date()

  init(queue: DispatchQueue, emit: @escaping ([String: Any]) -> Void) throws {
    self.queue = queue
    self.emit = emit
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  func start(_ promise: Promise) {
    var resolved = false
    listener.stateUpdateHandler = { [weak self] state in
      guard let self, !resolved else { return }
      switch state {
      case .ready:
        resolved = true
        promise.resolve(["id": self.id, "url": "http://127.0.0.1:\(self.listener.port!.rawValue)\(self.path)"])
      case .failed:
        resolved = true
        promise.reject("media_open", "Could not open video stream")
        self.close()
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.start(queue: queue)
    expireWhenIdle()
  }

  private func expireWhenIdle() {
    // Keep long videos seekable while active; abandoned viewer capabilities expire after fifteen idle minutes.
    queue.asyncAfter(deadline: .now() + 900) { [weak self] in
      guard let self else { return }
      if Date().timeIntervalSince(self.lastActivity) >= 900 { self.close() }
      else { self.expireWhenIdle() }
    }
  }

  private func accept(_ connection: NWConnection) {
    guard connections.count < 4 else { connection.cancel(); return }
    let requestId = UUID().uuidString
    connections[requestId] = connection
    reading.insert(requestId)
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.connections.removeValue(forKey: requestId); self?.reading.remove(requestId)
      default: break
      }
    }
    connection.start(queue: queue)
    receive(connection, requestId, Data())
    queue.asyncAfter(deadline: .now() + 10) { [weak self] in
      if self?.reading.contains(requestId) == true { connection.cancel() }
    }
  }

  private func receive(_ connection: NWConnection, _ requestId: String, _ previous: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] bytes, _, complete, error in
      guard let self, error == nil else { connection.cancel(); return }
      let data = previous + (bytes ?? Data())
      guard data.count <= 8192 else { connection.cancel(); return }
      if let text = String(data: data, encoding: .utf8), text.contains("\r\n\r\n") {
        self.reading.remove(requestId)
        let lines = text.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count == 3, ["GET", "HEAD"].contains(String(parts[0])), parts[1] == self.path else {
          connection.cancel(); return
        }
        let ranges = lines.dropFirst().filter { $0.lowercased().hasPrefix("range:") }
        guard ranges.count <= 1 else { connection.cancel(); return }
        let range = ranges.first.map { String($0.dropFirst(6)).trimmingCharacters(in: .whitespaces) } ?? ""
        self.lastActivity = Date()
        self.emit(["serverId": self.id, "requestId": requestId, "method": String(parts[0]), "range": range])
      } else if complete { connection.cancel() }
      else { self.receive(connection, requestId, data) }
    }
  }

  func write(_ requestId: String, _ status: Int, _ headers: [String: String], _ data: Data, _ end: Bool, _ promise: Promise) {
    guard let connection = connections[requestId], data.count <= 262144,
      headers.allSatisfy({ !$0.key.contains("\r") && !$0.key.contains("\n") && !$0.value.contains("\r") && !$0.value.contains("\n") }) else {
      promise.reject("media_closed", "Video stream closed"); return
    }
    var body = Data()
    if status > 0 {
      body = Data(("HTTP/1.1 \(status) Media\r\nConnection: close\r\n" + headers.map { "\($0.key): \($0.value)\r\n" }.joined() + "\r\n").utf8)
    }
    body.append(data)
    lastActivity = Date()
    connection.send(content: body, completion: .contentProcessed { [weak self] error in
      if end || error != nil { self?.connections.removeValue(forKey: requestId); connection.cancel() }
      if error != nil { promise.reject("media_write", "Video stream closed") }
      else { promise.resolve(nil) }
    })
  }

  func close() {
    listener.cancel()
    connections.values.forEach { $0.cancel() }
    connections.removeAll()
    reading.removeAll()
  }
}
