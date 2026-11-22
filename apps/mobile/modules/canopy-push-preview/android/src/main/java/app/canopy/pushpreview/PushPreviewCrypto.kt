package app.canopy.pushpreview

import android.util.Base64
import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

internal data class PushPreview(val title: String, val body: String)

internal object PushPreviewCrypto {
  const val KEY_BYTES = 32
  private const val NONCE_BYTES = 12
  private const val TAG_BYTES = 16
  private const val CIPHER = "AES/GCM/NoPadding"
  private const val BASE64URL = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
  private val base64url = Regex("[A-Za-z0-9_-]+")

  fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, BASE64URL)

  fun decode(encoded: String): ByteArray? {
    if (encoded.length > 4096 || !base64url.matches(encoded)) return null
    val bytes = try {
      Base64.decode(encoded, BASE64URL)
    } catch (_: IllegalArgumentException) {
      return null
    }
    return bytes.takeIf { encode(it) == encoded }
  }

  fun encrypt(key: SecretKey, plaintext: ByteArray, aad: String): ByteArray {
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return cipher.iv + cipher.doFinal(plaintext)
  }

  fun decrypt(key: SecretKey, envelope: ByteArray, aad: String): ByteArray? {
    if (envelope.size <= NONCE_BYTES + TAG_BYTES) return null
    val cipher = Cipher.getInstance(CIPHER)
    val parameters = GCMParameterSpec(TAG_BYTES * 8, envelope, 0, NONCE_BYTES)
    cipher.init(Cipher.DECRYPT_MODE, key, parameters)
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return cipher.doFinal(envelope, NONCE_BYTES, envelope.size - NONCE_BYTES)
  }

  fun decryptPreview(rawKey: ByteArray, receiptId: String, encoded: String): PushPreview? {
    val envelope = decode(encoded) ?: return null
    val key = SecretKeySpec(rawKey, "AES")
    val plaintext = decrypt(key, envelope, "canopy-push-preview-v1:$receiptId") ?: return null
    try {
      val payload = JSONObject(Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(plaintext)).toString())
      val title = payload.opt("title") as? String ?: return null
      val body = payload.opt("body") as? String ?: return null
      return PushPreview(title, body)
    } finally {
      plaintext.fill(0)
    }
  }
}
