import ExpoModulesCore
import UIKit

/// Wraps a thread screen on iPad: files dragged from another app show the overlay (`onDragState`) and, dropped,
/// reach `onFiles`. Drags that start in the app are not files to add.
public class CanopyDropView: ExpoView, UIDropInteractionDelegate {
  let onFiles = EventDispatcher()
  let onDragState = EventDispatcher()
  var maxBytes = 20 * 1024 * 1024
  var accepting = true
  private var over = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addInteraction(UIDropInteraction(delegate: self))
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  private func hover(_ next: Bool) {
    guard over != next else { return }
    over = next
    onDragState(["over": next])
  }

  public func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
    accepting && session.localDragSession == nil && IntakeFiles.carriesFiles(session.items.map(\.itemProvider))
  }

  public func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnter session: UIDropSession) {
    hover(true)
  }

  public func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession)
    -> UIDropProposal
  {
    UIDropProposal(operation: .copy)
  }

  public func dropInteraction(_ interaction: UIDropInteraction, sessionDidExit session: UIDropSession) {
    hover(false)
  }

  public func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnd session: UIDropSession) {
    hover(false)
  }

  public func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
    hover(false)
    IntakeFiles.load(session.items.map(\.itemProvider), maxBytes: maxBytes) { [weak self] files in
      if !files.isEmpty { self?.onFiles(["files": files]) }
    }
  }
}
