package app.canopy.pinnedfetch

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers.Companion.toHeaders
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

private fun fingerprint(certificate: X509Certificate) =
  MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }

private fun matches(fingerprint: String, pin: String) = pin.length == 64 && fingerprint == pin

/** Trust only the pinned certificate of the paired computer: system roots and host names are replaced
 * by the exact SHA-256 pin obtained while pairing. */
private class PinTrust(private val pin: String) : X509TrustManager {
  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException()

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    if (chain.isEmpty() || !matches(fingerprint(chain[0]), pin)) throw CertificateException("pin")
  }

  override fun getAcceptedIssuers() = arrayOf<X509Certificate>()
}

private fun context(pin: String): Pair<SSLContext, PinTrust> {
  val trust = PinTrust(pin)
  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(trust), null)
  return context to trust
}

/** The exception class and its root cause (`SSLHandshakeException / CertPathValidatorException`):
 * enough to diagnose, never an address. */
private fun code(error: Throwable): String {
  var root = error
  while (root.cause != null && root.cause !== root) root = root.cause!!
  val name = error.javaClass.simpleName
  return if (root === error) name else "$name / ${root.javaClass.simpleName}"
}

private fun pinFailure(error: Throwable?): Boolean {
  var cause = error
  while (cause != null) {
    if (cause is CertificateException) return true
    cause = cause.cause
  }
  return false
}

class CanopyPinnedFetchModule : Module() {
  private val calls = ConcurrentHashMap<String, Call>()
  private val clients = ConcurrentHashMap<String, OkHttpClient>()
  private val base by lazy {
    OkHttpClient.Builder()
      .connectTimeout(8, TimeUnit.SECONDS)
      // Overview and thread streams stay open and may be quiet for a long time.
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      // Without it a connection that died while the app was in the background (NAT, Wi-Fi change) keeps
      // streams and new requests waiting forever, since a quiet stream has no read timeout.
      .pingInterval(15, TimeUnit.SECONDS)
      .build()
  }

  /** Probes block on connect and handshake. Expo runs every module's AsyncFunction on one shared thread, so
   * they run here instead: in parallel, and without delaying requests or other modules. */
  private val probes = Executors.newCachedThreadPool { task -> Thread(task, "canopy-probe").apply { isDaemon = true } }

  /** One client per pin, so connections to the computer are reused and never shared across pins. */
  private fun client(pin: String) =
    clients.getOrPut(pin) {
      val (context, trust) = context(pin)
      base.newBuilder()
        .sslSocketFactory(context.socketFactory, trust)
        // The exact certificate pin is stronger than a host name check (addresses change, names are optional).
        .hostnameVerifier { _, _ -> true }
        .build()
    }

  override fun definition() = ModuleDefinition {
    Name("CanopyPinnedFetch")
    Events("onResponse", "onData", "onEnd", "onError")

    AsyncFunction("start") { id: String, url: String, method: String, headers: Map<String, String>, body: ByteArray?, pin: String ->
      if (!url.startsWith("https://")) throw IllegalArgumentException("Only HTTPS addresses are allowed")
      val type = headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value?.toMediaTypeOrNull()
      val request = Request.Builder()
        .url(url)
        .headers(headers.toHeaders())
        .method(method, if (method == "GET" || method == "HEAD") null else (body ?: ByteArray(0)).toRequestBody(type))
        .build()
      val call = client(pin.lowercase()).newCall(request)
      calls[id] = call
      call.enqueue(callback(id))
    }

    Function("cancel") { id: String -> calls.remove(id)?.cancel() }

    // New requests open new connections; running ones keep theirs (the clients share one pool).
    Function("reset") { base.connectionPool.evictAll() }

    // A TLS handshake only: is this route the paired computer, and how fast? Nothing is sent.
    AsyncFunction("probe") { host: String, port: Int, pin: String, timeoutMs: Int, promise: Promise ->
      probes.execute { probe(host, port, pin.lowercase(), timeoutMs, promise) }
    }
  }

  private fun probe(host: String, port: Int, pin: String, timeoutMs: Int, promise: Promise) {
    val started = System.nanoTime()
    try {
      val (context, _) = context(pin)
      Socket().use { raw ->
        raw.connect(InetSocketAddress(host, port), timeoutMs)
        raw.soTimeout = timeoutMs
        (context.socketFactory.createSocket(raw, host, port, false) as SSLSocket).use { tls ->
          tls.startHandshake()
          val leaf = tls.session.peerCertificates.firstOrNull() as? X509Certificate
          promise.resolve(
            mapOf(
              "ok" to true,
              "fingerprint" to (leaf?.let(::fingerprint) ?: ""),
              "latencyMs" to ((System.nanoTime() - started) / 1_000_000).toInt(),
            ),
          )
        }
      }
    } catch (error: Exception) {
      // Off the module thread nothing rejects the promise for us: every failure must resolve it.
      promise.resolve(mapOf("ok" to false, "kind" to if (pinFailure(error)) "pin" else "connect", "code" to code(error)))
    }
  }

  private fun callback(id: String) = object : Callback {
    override fun onFailure(call: Call, e: IOException) {
      calls.remove(id)
      // connect: the computer's app never answered, another route may work.
      sendEvent(
        "onError",
        mapOf("id" to id, "kind" to if (pinFailure(e)) "pin" else "connect", "message" to (e.message ?: ""), "code" to code(e)),
      )
    }

    override fun onResponse(call: Call, response: Response) {
      val leaf = response.handshake?.peerCertificates?.firstOrNull() as? X509Certificate
      val headers = response.headers.names().associate { it.lowercase() to response.headers.values(it).joinToString(", ") }
      sendEvent(
        "onResponse",
        mapOf("id" to id, "status" to response.code, "headers" to headers, "fingerprint" to (leaf?.let(::fingerprint) ?: "")),
      )
      try {
        response.body?.byteStream()?.use { stream ->
          val buffer = ByteArray(16 * 1024)
          while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            if (read > 0) sendEvent("onData", mapOf("id" to id, "data" to Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)))
          }
        }
        sendEvent("onEnd", mapOf("id" to id))
      } catch (e: IOException) {
        sendEvent("onError", mapOf("id" to id, "kind" to "io", "message" to (e.message ?: ""), "code" to code(e)))
      } finally {
        calls.remove(id)
        response.close()
      }
    }
  }
}
