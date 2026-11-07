import ExpoModulesCore
import UIKit

/// Wraps the composer's text field: images and files pasted into it reach `onFiles` (PasteHook), text pastes as
/// before. Registers the text view inside once it is laid out.
public class CanopyPasteView: ExpoView {
  let onFiles = EventDispatcher()
  var maxBytes = 20 * 1024 * 1024
  private weak var field: UIView?

  public override func layoutSubviews() {
    super.layoutSubviews()
    attach()
  }

  public override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)

    if newWindow == nil, let field {
      PasteHook.unregister(field)
      self.field = nil
    }
  }

  private func attach() {
    guard let found = Self.textView(in: self), found !== field else { return }

    if let field { PasteHook.unregister(field) }
    PasteHook.register(found, owner: self)
    field = found
  }

  private static func textView(in view: UIView) -> UIView? {
    if view is UITextView || view is UITextField { return view }

    for child in view.subviews {
      if let found = textView(in: child) { return found }
    }

    return nil
  }

  func receive(_ providers: [NSItemProvider]) {
    IntakeFiles.load(providers, maxBytes: maxBytes) { [weak self] files in
      if !files.isEmpty { self?.onFiles(["files": files]) }
    }
  }
}
