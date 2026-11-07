package app.canopy.fileintake

import android.content.ClipDescription
import android.content.Context
import android.net.Uri
import android.view.DragEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

private val TEXT_TYPES =
  setOf(ClipDescription.MIMETYPE_TEXT_PLAIN, ClipDescription.MIMETYPE_TEXT_HTML, ClipDescription.MIMETYPE_TEXT_INTENT)

/** A drag from another app that carries files (any type but bare text). */
private fun carriesFiles(description: ClipDescription?): Boolean =
  description != null && (0 until description.mimeTypeCount).any { description.getMimeType(it) !in TEXT_TYPES }

/**
 * Wraps a thread screen on large screens (split screen, foldables, desktop mode): files dragged from another app
 * show the overlay (`onDragState`) and, dropped, reach `onFiles`. The read grant covers only the dropped items and
 * is released after copying them.
 */
class CanopyDropView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onFiles by EventDispatcher()
  private val onDragState by EventDispatcher()
  private val files = IntakeFiles(context)
  var maxBytes: Long = 20L * 1024 * 1024
  var accepting = true
  private var over = false

  private fun hover(next: Boolean) {
    if (over == next) return
    over = next
    onDragState(mapOf("over" to next))
  }

  init {
    setOnDragListener { _, event ->
      when (event.action) {
        DragEvent.ACTION_DRAG_STARTED -> accepting && carriesFiles(event.clipDescription)
        DragEvent.ACTION_DRAG_ENTERED, DragEvent.ACTION_DRAG_LOCATION -> {
          hover(true)
          true
        }
        DragEvent.ACTION_DRAG_EXITED, DragEvent.ACTION_DRAG_ENDED -> {
          hover(false)
          true
        }
        DragEvent.ACTION_DROP -> {
          hover(false)
          drop(event)
          true
        }
        else -> true
      }
    }
  }

  private fun drop(event: DragEvent) {
    val clip = event.clipData ?: return
    val grant = appContext.currentActivity?.requestDragAndDropPermissions(event)
    val uris = (0 until clip.itemCount).mapNotNull<Int, Uri> { clip.getItemAt(it).uri }

    if (uris.isEmpty()) {
      grant?.release()

      return
    }

    files.copyAll(uris, maxBytes, after = { grant?.release() }) { taken ->
      if (taken.isNotEmpty()) onFiles(mapOf("files" to taken))
    }
  }
}
