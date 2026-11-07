import ObjectiveC
import UIKit
import UniformTypeIdentifiers

/// Native paste of images and files into a composer's text view. React Native's text views paste only text: for the
/// views a `CanopyPasteView` registered, "Paste" is offered when the clipboard holds files, and a paste without text
/// hands the clipboard's files to the view. Other text views, and pastes with text, keep the original behaviour.
/// Reading the clipboard here follows the user's own Paste, so iOS shows no paste prompt.
enum PasteHook {
  private static let owners = NSMapTable<UIView, CanopyPasteView>.weakToWeakObjects()
  private static var hooked = Set<ObjectIdentifier>()

  static func register(_ input: UIView, owner: CanopyPasteView) {
    owners.setObject(owner, forKey: input)
    hook(type(of: input))
  }

  static func unregister(_ input: UIView) {
    owners.removeObject(forKey: input)
  }

  /// Files on the clipboard, judged by their types only (reading them would prompt).
  private static var clipboardHasFiles: Bool {
    let board = UIPasteboard.general

    return board.hasImages || board.types.contains { identifier in
      guard let type = UTType(identifier) else { return false }

      return type.conforms(to: .data) && !type.conforms(to: .text) && !type.conforms(to: .url)
    }
  }

  private static func owner(of object: AnyObject) -> CanopyPasteView? {
    (object as? UIView).flatMap { owners.object(forKey: $0) }
  }

  private static func hook(_ cls: AnyClass) {
    guard hooked.insert(ObjectIdentifier(cls)).inserted else { return }
    let pasteAction = #selector(UIResponderStandardEditActions.paste(_:))

    typealias CanPerform = @convention(c) (AnyObject, Selector, Selector, Any?) -> Bool
    let canSelector = #selector(UIResponder.canPerformAction(_:withSender:))
    replace(cls, canSelector) { (original: IMP) -> Any in
      let call = unsafeBitCast(original, to: CanPerform.self)
      let block: @convention(block) (AnyObject, Selector, Any?) -> Bool = { this, action, sender in
        if action == pasteAction, owner(of: this) != nil, clipboardHasFiles { return true }

        return call(this, canSelector, action, sender)
      }

      return block
    }

    typealias Paste = @convention(c) (AnyObject, Selector, Any?) -> Void
    replace(cls, pasteAction) { (original: IMP) -> Any in
      let call = unsafeBitCast(original, to: Paste.self)
      let block: @convention(block) (AnyObject, Any?) -> Void = { this, sender in
        let board = UIPasteboard.general

        if let view = owner(of: this), !board.hasStrings, clipboardHasFiles {
          view.receive(board.itemProviders)

          return
        }

        call(this, pasteAction, sender)
      }

      return block
    }
  }

  /// Puts `make(original)` in place of `selector` on `cls` only: an inherited method gets an override on `cls`.
  private static func replace(_ cls: AnyClass, _ selector: Selector, make: (IMP) -> Any) {
    guard let method = class_getInstanceMethod(cls, selector) else { return }
    let original = method_getImplementation(method)
    let replacement = imp_implementationWithBlock(make(original))

    if !class_addMethod(cls, selector, replacement, method_getTypeEncoding(method)) {
      method_setImplementation(method, replacement)
    }
  }
}
