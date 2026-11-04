import CryptoKit
import ExpoModulesCore
import Foundation
import Network

/// HTTPS to the paired computer. Trust comes only from the pinned SHA-256 of the computer's own
/// certificate: system roots and host names are replaced by the pin, like linked computers do.
/// The exact SHA-256 fingerprint is transferred out of band during pairing.
public class CanopyPinnedFetchModule: Module {
  private lazy var calls = PinnedCalls(emit: { [weak self] name, body in self?.sendEvent(name, body) })

  public func definition() -> ModuleDefinition {
    Name("CanopyPinnedFetch")
    Events("onResponse", "onData", "onEnd", "onError")

    AsyncFunction("start") {
      (id: String, url: String, method: String, headers: [String: String], body: Data?, pin: String) in
      guard let target = URL(string: url), target.scheme == "https", target.user == nil else {
        throw InvalidAddressException()
      }
      var request = URLRequest(url: target)
      request.httpMethod = method
      request.httpShouldHandleCookies = false
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      request.httpBody = body
      self.calls.start(id: id, request: request, pin: pin.lowercased())
    }

    Function("cancel") { (id: String) in self.calls.cancel(id: id) }

    // A TLS handshake only: is this route the paired computer, and how fast? Nothing is sent.
    AsyncFunction("probe") { (host: String, port: Int, pin: String, timeoutMs: Int, promise: Promise) in
      probe(host: host, port: port, pin: pin.lowercased(), timeoutMs: timeoutMs, promise: promise)
    }
  }
}

final class InvalidAddressException: Exception {
  override var reason: String { "Only HTTPS addresses without credentials are allowed" }
}

func fingerprint(_ certificate: SecCertificate) -> String {
  SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
}

func matches(_ fingerprint: String, _ pin: String) -> Bool {
  pin.count == 64 && fingerprint == pin
}

func leaf(_ trust: SecTrust) -> SecCertificate? {
  (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
}

private func probe(host: String, port: Int, pin: String, timeoutMs: Int, promise: Promise) {
  let queue = DispatchQueue(label: "app.canopy.pinnedfetch.probe")
  let tls = NWProtocolTLS.Options()
  var matched = ""
  var mismatch = false
  sec_protocol_options_set_verify_block(
    tls.securityProtocolOptions,
    { _, trust, complete in
      let certificate = leaf(sec_trust_copy_ref(trust).takeRetainedValue())
      let value = certificate.map(fingerprint) ?? ""
      if matches(value, pin) { matched = value } else { mismatch = true }
      complete(!matched.isEmpty)
    }, queue)
  guard let endpointPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
    promise.resolve(["ok": false, "kind": "connect"])
    return
  }
  let connection = NWConnection(
    host: NWEndpoint.Host(host), port: endpointPort, using: NWParameters(tls: tls, tcp: .init()))
  let started = Date()
  var done = false
  func finish(_ result: [String: Any]) {
    if done { return }
    done = true
    connection.cancel()
    promise.resolve(result)
  }
  connection.stateUpdateHandler = { state in
    switch state {
    case .ready:
      finish(["ok": true, "fingerprint": matched, "latencyMs": Int(Date().timeIntervalSince(started) * 1000)])
    case .failed, .waiting:
      // .waiting: no route now (or the local network permission was refused).
      finish(["ok": false, "kind": mismatch ? "pin" : "connect"])
    default: break
    }
  }
  connection.start(queue: queue)
  queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { finish(["ok": false, "kind": "connect"]) }
}

/// Requests share one session (its connections are reused per route); delegate callbacks are serial.
final class PinnedCalls: NSObject, URLSessionDataDelegate {
  final class Call {
    let id: String
    let pin: String
    var fingerprint = ""
    var responded = false
    var pinFailed = false
    init(id: String, pin: String) {
      self.id = id
      self.pin = pin
    }
  }

  private let emit: (String, [String: Any?]) -> Void
  private let queue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private var byTask: [URLSessionTask: Call] = [:]
  private var byId: [String: URLSessionDataTask] = [:]
  private var sessions: [String: URLSession] = [:]
  private func session(pin: String) -> URLSession {
    if let existing = sessions[pin] { return existing }
    let config = URLSessionConfiguration.ephemeral
    // Overview and thread streams stay open and may be quiet for a long time.
    config.timeoutIntervalForRequest = 24 * 3600
    config.timeoutIntervalForResource = 7 * 24 * 3600
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.urlCredentialStorage = nil
    config.waitsForConnectivity = false
    let value = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    sessions[pin] = value
    return value
  }

  init(emit: @escaping (String, [String: Any?]) -> Void) {
    self.emit = emit
  }

  func start(id: String, request: URLRequest, pin: String) {
    queue.addOperation {
      let task = self.session(pin: pin).dataTask(with: request)
      self.byTask[task] = Call(id: id, pin: pin)
      self.byId[id] = task
      task.resume()
    }
  }

  func cancel(id: String) {
    queue.addOperation { self.byId[id]?.cancel() }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
      // The computer asks for an optional client certificate (linked computers have one); phones have none.
      completionHandler(.performDefaultHandling, nil)
      return
    }
    guard let call = byTask[task], let certificate = leaf(trust) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let value = fingerprint(certificate)
    if matches(value, call.pin) {
      call.fingerprint = value
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      call.pinFailed = true
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  // Never follow a redirect with a device token.
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let call = byTask[dataTask], let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }
    call.responded = true
    var headers: [String: String] = [:]
    for (name, value) in http.allHeaderFields {
      if let name = name as? String, let value = value as? String { headers[name.lowercased()] = value }
    }
    emit(
      "onResponse",
      ["id": call.id, "status": http.statusCode, "headers": headers, "fingerprint": call.fingerprint])
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let call = byTask[dataTask] else { return }
    emit("onData", ["id": call.id, "data": data.base64EncodedString()])
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let call = byTask.removeValue(forKey: task) else { return }
    byId.removeValue(forKey: call.id)
    guard let error else {
      emit("onEnd", ["id": call.id])
      return
    }
    // connect: nothing reached the computer's app, another route may work; io: the response broke off.
    let kind = call.pinFailed ? "pin" : call.responded ? "io" : "connect"
    emit("onError", ["id": call.id, "kind": kind, "message": error.localizedDescription])
  }
}
