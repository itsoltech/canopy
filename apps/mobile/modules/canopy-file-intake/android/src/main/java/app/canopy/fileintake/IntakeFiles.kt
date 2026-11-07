package app.canopy.fileintake

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** A file taken from a paste or a drop: copied into the app cache, or only named when it is over the limit. */
internal fun intakeEntry(name: String, size: Long, mimeType: String?, file: File?): Map<String, Any?> =
  mapOf("uri" to file?.let { Uri.fromFile(it).toString() }, "name" to name, "size" to size, "mimeType" to mimeType)

/**
 * Copies content URIs the user pasted or dropped into `cacheDir/canopy-intake`, where the attachment upload reads
 * them (and deletes them). Only URIs handed over by the system for this paste or drop are read; a file over
 * `maxBytes` is not copied, only reported with its size, so the composer says why it was not attached.
 */
internal class IntakeFiles(private val context: Context) {
  private val dir get() = File(context.cacheDir, "canopy-intake")

  fun clear() {
    dir.deleteRecursively()
  }

  /** Copies off the main thread; `done` runs on the main thread with the files in their order. */
  fun copyAll(uris: List<Uri>, maxBytes: Long, after: () -> Unit = {}, done: (List<Map<String, Any?>>) -> Unit) {
    executor.execute {
      val files = uris.mapNotNull { uri -> runCatching { copy(uri, maxBytes) }.getOrNull() }
      after()
      android.os.Handler(context.mainLooper).post { done(files) }
    }
  }

  private fun copy(uri: Uri, maxBytes: Long): Map<String, Any?> {
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri)
    var name: String? = null
    var size = -1L

    if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
        if (it.moveToFirst()) {
          name = it.getString(0)
          if (!it.isNull(1)) size = it.getLong(1)
        }
      }
    }
    val fileName = safeName(name ?: uri.lastPathSegment, mimeType)

    if (size > maxBytes) return intakeEntry(fileName, size, mimeType, null)
    val target = File(File(dir, UUID.randomUUID().toString()).apply { mkdirs() }, fileName)
    var copied = 0L
    val input = resolver.openInputStream(uri) ?: throw IllegalStateException("unreadable")

    input.use { source ->
      target.outputStream().use { sink ->
        val buffer = ByteArray(64 * 1024)

        while (true) {
          val read = source.read(buffer)
          if (read < 0) break
          copied += read
          // A size the provider did not report: stop past the limit instead of filling the cache.
          if (copied > maxBytes) break
          sink.write(buffer, 0, read)
        }
      }
    }

    if (copied > maxBytes) {
      target.parentFile?.deleteRecursively()

      return intakeEntry(fileName, copied, mimeType, null)
    }

    return intakeEntry(fileName, copied, mimeType, target)
  }

  private fun safeName(raw: String?, mimeType: String?): String {
    val base = raw?.substringAfterLast('/')?.replace(Regex("[\\u0000-\\u001f\\\\:]"), "")?.trim().orEmpty()
    val extension = mimeType?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }

    if (base.isNotEmpty() && base != "." && base != "..") {
      return if (base.contains('.') || extension == null) base else "$base.$extension"
    }

    val stem = if (mimeType?.startsWith("image/") == true) "pasted-image" else "pasted-file"

    return if (extension == null) stem else "$stem.$extension"
  }

  companion object {
    private val executor = Executors.newSingleThreadExecutor()
  }
}
