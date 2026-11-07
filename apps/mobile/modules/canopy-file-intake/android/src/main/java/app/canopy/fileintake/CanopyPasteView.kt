package app.canopy.fileintake

import android.content.Context
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference

/** The content a composer takes besides text: images from keyboards and clipboards, and any file. */
private val CONTENT_TYPES = arrayOf("image/*", "video/*", "audio/*", "application/*")

private fun findEditText(view: View): EditText? {
  if (view is EditText) return view
  if (view !is ViewGroup) return null

  for (index in 0 until view.childCount) findEditText(view.getChildAt(index))?.let { return it }

  return null
}

/**
 * Wraps the composer's text field. Images and files pasted into it (the clipboard, a keyboard's image or clipboard
 * strip) or dropped on it reach `onFiles`; text pastes as before. Listens on the EditText inside, found after layout.
 */
class CanopyPasteView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onFiles by EventDispatcher()
  private val files = IntakeFiles(context)
  private val pendingContent = mutableSetOf<ContentInfoCompat>()
  private var field: WeakReference<EditText>? = null
  var maxBytes: Long = 20L * 1024 * 1024

  private val receiver = OnReceiveContentListener { _, payload ->
    val split = payload.partition { it.uri != null }
    val withUris: ContentInfoCompat? = split.first
    val rest: ContentInfoCompat? = split.second

    if (withUris != null) {
      val clip = withUris.clip
      val uris = (0 until clip.itemCount).mapNotNull<Int, Uri> { clip.getItemAt(it).uri }

      // URI grants follow the payload's lifetime. Keep it alive through the asynchronous copy.
      pendingContent.add(payload)
      files.copyAll(uris, maxBytes) { taken ->
        pendingContent.remove(payload)
        if (taken.isNotEmpty()) onFiles(mapOf("files" to taken))
      }
    }

    rest
  }

  private val follow = ViewTreeObserver.OnGlobalLayoutListener { attach() }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnGlobalLayoutListener(follow)
    attach()
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnGlobalLayoutListener(follow)
    field?.get()?.let { ViewCompat.setOnReceiveContentListener(it, null, null) }
    field = null
    super.onDetachedFromWindow()
  }

  private fun attach() {
    val found = findEditText(this) ?: return

    if (field?.get() === found) return
    field?.get()?.let { ViewCompat.setOnReceiveContentListener(it, null, null) }
    ViewCompat.setOnReceiveContentListener(found, CONTENT_TYPES, receiver)
    field = WeakReference(found)
  }
}
