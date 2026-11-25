#import <AppKit/AppKit.h>
#include <node_api.h>

static void SetNumber(napi_env env, napi_value value, const char* name, CGFloat number) {
  napi_value property;
  napi_create_double(env, number, &property);
  napi_set_named_property(env, value, name, property);
}

static napi_value PrimaryCutout(napi_env env, napi_callback_info) {
  NSScreen* screen = NSScreen.screens.firstObject;
  CGFloat height = screen ? screen.safeAreaInsets.top : 0;
  napi_value result;

  if (height <= 0) {
    napi_get_undefined(env, &result);
    return result;
  }

  const NSRect left = screen.auxiliaryTopLeftArea;
  const NSRect right = screen.auxiliaryTopRightArea;
  const CGFloat start = NSMaxX(left);
  const CGFloat end = NSMinX(right);

  if (NSIsEmptyRect(left) || NSIsEmptyRect(right) || start >= end) {
    napi_get_undefined(env, &result);
    return result;
  }

  napi_create_object(env, &result);
  SetNumber(env, result, "center", (start + end) / 2 - NSMinX(screen.frame));
  SetNumber(env, result, "width", end - start);
  SetNumber(env, result, "height", height);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value read;
  napi_create_function(env, "primaryCutout", NAPI_AUTO_LENGTH, PrimaryCutout, nullptr, &read);
  napi_set_named_property(env, exports, "primaryCutout", read);
  return exports;
}
