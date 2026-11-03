#import <AppKit/AppKit.h>
#include <node_api.h>

// Called synchronously inside MenuItem.click, while AppKit's currentEvent is
// still the key equivalent. No event monitor, key contents, or permissions.
static napi_value IsRepeat(napi_env env, napi_callback_info info) {
  NSEvent* event = [NSApp currentEvent];
  napi_value result;
  if (event != nil && event.type == NSEventTypeKeyDown) {
    napi_get_boolean(env, [event isARepeat], &result);
  } else {
    napi_get_undefined(env, &result);
  }
  return result;
}

static napi_value Timing(napi_env env, napi_callback_info info) {
  napi_value result, initial, interval;
  napi_create_object(env, &result);
  napi_create_double(env, [NSEvent keyRepeatDelay] * 1000, &initial);
  napi_create_double(env, [NSEvent keyRepeatInterval] * 1000, &interval);
  napi_set_named_property(env, result, "initialDelayMs", initial);
  napi_set_named_property(env, result, "intervalMs", interval);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "isRepeat", NAPI_AUTO_LENGTH, IsRepeat, nullptr, &function);
  napi_set_named_property(env, exports, "isRepeat", function);
  napi_create_function(env, "timing", NAPI_AUTO_LENGTH, Timing, nullptr, &function);
  napi_set_named_property(env, exports, "timing", function);
  return exports;
}
