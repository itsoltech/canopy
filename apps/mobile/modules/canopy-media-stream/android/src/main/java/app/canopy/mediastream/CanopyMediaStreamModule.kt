package app.canopy.mediastream

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** ExoPlayer sees only loopback bytes. All remote reads retain the app's existing pin and device authorization. */
class CanopyMediaStreamModule : Module() {
  private val servers = ConcurrentHashMap<String, MediaListener>()
  private val writers = Executors.newFixedThreadPool(4) { task -> Thread(task, "canopy-media-write").apply { isDaemon = true } }

  override fun definition() = ModuleDefinition {
    Name("CanopyMediaStream")
    Events("onRequest")
    AsyncFunction("open") {
      val server = MediaListener { event -> sendEvent("onRequest", event) }
      servers[server.id] = server
      server.start()
      mapOf("id" to server.id, "url" to server.url)
    }
    AsyncFunction("write") { serverId: String, requestId: String, status: Int, headers: Map<String, String>, data: ByteArray, end: Boolean, promise: Promise ->
      writers.execute {
        try {
          val server = servers[serverId] ?: throw IllegalStateException("Video stream closed")
          server.write(requestId, status, headers, data, end)
          promise.resolve(null)
        } catch (_: Exception) { promise.reject("media_write", "Video stream closed", null) }
      }
    }
    Function("close") { id: String -> servers.remove(id)?.close() }
    OnDestroy { servers.values.forEach { it.close() }; servers.clear(); writers.shutdownNow() }
  }
}

private class MediaListener(private val emit: (Map<String, String>) -> Unit) {
  val id = UUID.randomUUID().toString()
  private val path = "/${UUID.randomUUID()}${UUID.randomUUID()}"
  private val listener = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
  val url = "http://127.0.0.1:${listener.localPort}$path"
  private val sockets = ConcurrentHashMap<String, Socket>()
  @Volatile private var lastActivity = System.nanoTime()
  private val readers = Executors.newFixedThreadPool(4) { task -> Thread(task, "canopy-media-read").apply { isDaemon = true } }
  private val timer = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "canopy-media-expiry").apply { isDaemon = true } }

  fun start() {
    Thread({
      try {
        while (!listener.isClosed) {
          val socket = listener.accept()
          if (sockets.size >= 4) { socket.close(); continue }
          val requestId = UUID.randomUUID().toString()
          sockets[requestId] = socket
          readers.execute { receive(requestId, socket) }
        }
      } catch (_: Exception) { close() }
    }, "canopy-media-accept").apply { isDaemon = true; start() }
    // Active long videos keep their viewer capability; abandoned listeners expire after fifteen idle minutes.
    timer.scheduleAtFixedRate({
      if (System.nanoTime() - lastActivity >= TimeUnit.MINUTES.toNanos(15)) close()
    }, 15, 1, TimeUnit.MINUTES)
  }

  private fun receive(requestId: String, socket: Socket) {
    try {
      socket.soTimeout = 10000
      val input = socket.getInputStream()
      val bytes = ArrayList<Byte>()
      while (bytes.size < 8192) {
        val byte = input.read()
        if (byte < 0) throw IllegalStateException()
        bytes.add(byte.toByte())
        if (bytes.size >= 4 && bytes.takeLast(4) == listOf<Byte>(13, 10, 13, 10)) break
      }
      val lines = bytes.toByteArray().toString(Charsets.UTF_8).split("\r\n")
      val first = lines.first().split(' ')
      val ranges = lines.drop(1).filter { it.startsWith("range:", true) }
      require(bytes.size < 8192 && first.size == 3 && first[1] == path && first[0] in listOf("GET", "HEAD") && ranges.size <= 1)
      lastActivity = System.nanoTime()
      emit(mapOf("serverId" to id, "requestId" to requestId, "method" to first[0], "range" to (ranges.firstOrNull()?.substring(6)?.trim() ?: "")))
    } catch (_: Exception) { sockets.remove(requestId)?.close() }
  }

  fun write(requestId: String, status: Int, headers: Map<String, String>, data: ByteArray, end: Boolean) {
    val socket = sockets[requestId] ?: throw IllegalStateException("Video stream closed")
    require(data.size <= 262144 && headers.all { (key, value) -> !key.contains('\r') && !key.contains('\n') && !value.contains('\r') && !value.contains('\n') })
    try {
      val output = socket.getOutputStream()
      if (status > 0) {
        val header = "HTTP/1.1 $status Media\r\nConnection: close\r\n" + headers.entries.joinToString("") { "${it.key}: ${it.value}\r\n" } + "\r\n"
        output.write(header.toByteArray(Charsets.UTF_8))
      }
      output.write(data)
      output.flush()
      lastActivity = System.nanoTime()
      if (end) sockets.remove(requestId)?.close()
    } catch (_: Exception) {
      sockets.remove(requestId)?.close()
      throw IllegalStateException("Video stream closed")
    }
  }

  fun close() {
    listener.close()
    sockets.values.forEach { try { it.close() } catch (_: Exception) {} }
    sockets.clear()
    readers.shutdownNow()
    timer.shutdownNow()
  }
}
