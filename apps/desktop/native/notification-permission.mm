#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

static void ResolvePermission(napi_env env, napi_value, void* context, void* data) {
  if (env == nullptr) return;
  auto deferred = static_cast<napi_deferred>(context);
  napi_value value;
  if (data != nullptr) {
    napi_create_string_utf8(env, static_cast<const char*>(data), NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, deferred, value);
  } else {
    napi_value message;
    napi_create_string_utf8(env, "Could not check macOS notification permission", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &value);
    napi_reject_deferred(env, deferred, value);
  }
}

// UserNotifications invokes its completion blocks off the JavaScript thread.
static void Complete(napi_threadsafe_function callback, const char* status) {
  if (napi_call_threadsafe_function(callback, const_cast<char*>(status), napi_tsfn_nonblocking) != napi_closing)
    napi_release_threadsafe_function(callback, napi_tsfn_release);
}

static void ReadPermission(UNUserNotificationCenter* center, napi_threadsafe_function callback) {
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
    switch (settings.authorizationStatus) {
      case UNAuthorizationStatusAuthorized:
        Complete(callback, "granted");
        break;
      case UNAuthorizationStatusDenied:
        Complete(callback, "denied");
        break;
      default:
        Complete(callback, "default");
        break;
    }
  }];
}

static napi_value Permission(napi_env env, bool request) {
  napi_deferred deferred;
  napi_value promise, name;
  napi_threadsafe_function callback;
  napi_create_promise(env, &deferred, &promise);
  napi_create_string_utf8(env, "macOS notification permission", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, deferred,
                                      ResolvePermission, &callback) != napi_ok) {
    napi_throw_error(env, nullptr, "Could not start checking macOS notification permission");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, callback);

  UNUserNotificationCenter* center = UNUserNotificationCenter.currentNotificationCenter;
  if (request) {
    [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound |
                                             UNAuthorizationOptionBadge)
                          completionHandler:^(BOOL, NSError* error) {
      if (error == nil) ReadPermission(center, callback);
      else Complete(callback, nullptr);
    }];
  } else {
    ReadPermission(center, callback);
  }
  return promise;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "status", NAPI_AUTO_LENGTH,
                       [](napi_env env, napi_callback_info) { return Permission(env, false); }, nullptr, &function);
  napi_set_named_property(env, exports, "status", function);
  napi_create_function(env, "request", NAPI_AUTO_LENGTH,
                       [](napi_env env, napi_callback_info) { return Permission(env, true); }, nullptr, &function);
  napi_set_named_property(env, exports, "request", function);
  return exports;
}
