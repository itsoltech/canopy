package app.canopy.pushpreview

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.BadPaddingException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.json.JSONException
import org.json.JSONObject

// The Expo module and the FCM service use this object as their common lock in the app process.
internal object PushPreviewKeys {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val ALIAS = "CanopyPushPreviewWrapV1"
  private const val KEY_FILE = "canopy-push-preview.json"

  fun getOrCreateKey(context: Context, deviceId: String): String {
    require(deviceId.isNotBlank()) { "A device ID is required" }
    val file = keyFile(context)
    val stored = read(file)
    val store = keyStore()
    val existing = if (stored?.deviceId == deviceId) unwrap(store, stored) else null
    val raw = existing ?: create(context, store, file, deviceId)
    try {
      return PushPreviewCrypto.encode(raw)
    } finally {
      raw.fill(0)
    }
  }

  fun load(context: Context): ByteArray? {
    val stored = read(keyFile(context)) ?: return null
    return unwrap(keyStore(), stored)
  }

  fun clear(context: Context) {
    keyStore().deleteEntry(ALIAS)
    keyFile(context).delete()
    PushPreviewNotifications.cancel(context)
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  private fun keyFile(context: Context): AtomicFile =
    AtomicFile(File(context.noBackupFilesDir, KEY_FILE))

  private data class WrappedKey(val deviceId: String, val bytes: ByteArray)

  private fun read(file: AtomicFile): WrappedKey? {
    val data = try {
      JSONObject(file.readFully().toString(Charsets.UTF_8))
    } catch (_: FileNotFoundException) {
      return null
    } catch (_: JSONException) {
      return null
    }
    val deviceId = data.opt("deviceId") as? String ?: return null
    val encoded = data.opt("wrapped") as? String ?: return null
    val wrapped = PushPreviewCrypto.decode(encoded) ?: return null
    return WrappedKey(deviceId, wrapped)
  }

  private fun unwrap(store: KeyStore, stored: WrappedKey): ByteArray? {
    val key = store.getKey(ALIAS, null) as? SecretKey ?: return null
    val raw = try {
      PushPreviewCrypto.decrypt(key, stored.bytes, wrapAad(stored.deviceId))
    } catch (_: BadPaddingException) {
      return null
    } ?: return null
    if (raw.size == PushPreviewCrypto.KEY_BYTES) return raw
    raw.fill(0)
    return null
  }

  private fun create(context: Context, store: KeyStore, file: AtomicFile, deviceId: String): ByteArray {
    // Drop the previous wrapping key so replaced device keys cannot be recovered from old files.
    store.deleteEntry(ALIAS)
    PushPreviewNotifications.cancel(context)
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build()
    )
    val key = generator.generateKey()
    val raw = ByteArray(PushPreviewCrypto.KEY_BYTES).also { SecureRandom().nextBytes(it) }
    try {
      val wrapped = PushPreviewCrypto.encrypt(key, raw, wrapAad(deviceId))
      write(file, deviceId, wrapped)
      return raw
    } catch (error: Exception) {
      raw.fill(0)
      throw error
    }
  }

  private fun wrapAad(deviceId: String) = "canopy-push-preview-key-v1:$deviceId"

  private fun write(file: AtomicFile, deviceId: String, wrapped: ByteArray) {
    val bytes = JSONObject()
      .put("deviceId", deviceId)
      .put("wrapped", PushPreviewCrypto.encode(wrapped))
      .toString()
      .toByteArray(Charsets.UTF_8)
    val stream = file.startWrite()
    try {
      stream.write(bytes)
      stream.fd.sync()
      file.finishWrite(stream)
    } catch (error: IOException) {
      file.failWrite(stream)
      throw error
    }
    // AtomicFile reports rename failures only to logcat. Verify before returning the key to JS.
    if (!file.readFully().contentEquals(bytes)) throw IOException("Could not save the push preview key")
  }
}
