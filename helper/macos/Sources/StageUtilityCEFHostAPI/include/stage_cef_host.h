// The browser host's C API: everything the Swift app asks of Chromium (CEF), and
// everything Chromium tells it back.
//
// The host is a dylib, `libStageUtilityCEFHost.dylib` in the app's Frameworks
// folder, built with CMake against the pinned CEF distribution (see CEFHost/). The
// Swift app does not link it: `su_cef_load` opens it at run time and returns its
// table of functions. So the Swift package builds, and its tests run, with no CEF
// on the machine, and an app whose host is missing or damaged starts and says so in
// its window instead of failing to launch.
//
// Threads: every function and every callback is on the main thread (CEF's UI
// thread on macOS), except `begin_frame`, which a frame clock calls from its own
// queue.
#ifndef STAGE_CEF_HOST_H
#define STAGE_CEF_HOST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Bumped whenever the table below changes shape. The app refuses a host built
/// for another version rather than calling through a mismatched table.
#define SU_CEF_API_VERSION 2

/// One browser: a page in a window (a display output) or in no window at all (a
/// card output). Opaque.
typedef struct su_browser su_browser;

/// What a browser reports. Strings are UTF-8 and valid only during the call.
/// `context` is handed back unchanged. No callback arrives after `close`.
typedef struct su_browser_events {
  void* context;
  /// The main frame committed a page: the address now on the screen and the HTTP
  /// status of its response (0 when there was none). Not called for a navigation
  /// that fails before it commits.
  void (*committed)(void* context, const char* url, int http_status);
  /// The main frame finished loading.
  void (*finished)(void* context, int http_status);
  /// A main-frame navigation failed or was cancelled. `error_code` is Chromium's
  /// net error (net_error_list.h): -3 is ERR_ABORTED, a load that was replaced.
  void (*failed)(void* context, int error_code, const char* error_text, const char* url);
  /// The page's renderer process ended: crashed, killed, out of memory. The page
  /// is gone until it is loaded again.
  void (*process_gone)(void* context, int termination_status, int error_code, const char* text);
  /// A windowless browser drew a frame. `io_surface` is an IOSurfaceRef, valid only
  /// until this returns: copy or blit it here. Never called for a windowed browser.
  void (*painted)(void* context, void* io_surface);
} su_browser_events;

typedef struct su_cef_settings {
  /// Chromium's profile: cookies, local storage, cache. Must not be shared with
  /// another running copy.
  const char* cache_path;
  /// CEF's own log (warnings and worse).
  const char* log_file;
  /// Switches for Chromium's browser process, each `name` or `name=value` without
  /// the leading dashes: `ChromiumSwitches.browser` in the Swift core, where they
  /// are tested. `switch_count` of them; the strings are copied.
  const char* const* switches;
  size_t switch_count;
  void* context;
  /// CEF is ready for browsers. Browsers must not be made before this.
  void (*context_initialized)(void* context);
} su_cef_settings;

/// A DevTools method's result as JSON (for Page.captureScreenshot,
/// `{"data":"<base64 png>"}`), or why there is none.
typedef void (*su_devtools_done)(void* context, const char* json, size_t length, const char* error);

typedef struct su_cef_api {
  uint32_t version;
  /// The CEF and Chromium versions the host was built against.
  const char* (*cef_version)(void);
  /// Whether the helper processes run in Chromium's sandbox.
  bool (*sandboxed)(void);
  /// The NSApplication subclass CEF needs as the app (it conforms to
  /// CefAppProtocol). The app must be made from it, before `initialize`.
  const char* (*application_class_name)(void);
  /// Load the Chromium framework and start CEF. On failure, writes why to `error`.
  bool (*initialize)(const su_cef_settings* settings, char* error, size_t error_size);
  /// Run AppKit's event loop with Chromium's work in it, until `quit_when_closed`.
  void (*run_message_loop)(void);
  /// Close every browser, then end the loop (after 3 s at most).
  void (*quit_when_closed)(void);
  /// After the loop has ended.
  void (*shutdown)(void);

  /// A browser drawing into `parent_view` (an NSView already in a window), filling
  /// it and following its size.
  su_browser* (*create_windowed)(void* parent_view, const char* url, const su_browser_events* events);
  /// A browser with no window, `width` x `height`, that draws a frame only when
  /// `begin_frame` asks and hands each one to `events->painted` as an IOSurface.
  su_browser* (*create_windowless)(int width, int height, const char* url, const su_browser_events* events);
  void (*load)(su_browser* browser, const char* url);
  void (*reload)(su_browser* browser);
  /// A windowless browser's new size. Nothing for a windowed one, which follows its view.
  void (*resize)(su_browser* browser, int width, int height);
  /// Ask a windowless browser for one frame now: run the page's animation frame,
  /// composite, paint. Any thread. A frame is painted even when nothing on the page
  /// changed, so every request gets a picture.
  void (*begin_frame)(su_browser* browser);
  /// Call a DevTools protocol method (`params_json` an object, or NULL). The app
  /// uses Page.captureScreenshot: a PNG of the page as the renderer draws it, which
  /// needs no Screen Recording permission. `done` is called exactly once, with an
  /// error if the browser closes first.
  void (*devtools)(su_browser* browser, const char* method, const char* params_json, void* context,
                   su_devtools_done done);
  /// Close and free. Nothing is called back for it afterwards.
  void (*close)(su_browser* browser);
} su_cef_api;

/// Exported by the host dylib.
const su_cef_api* su_cef_host_api(void);

/// In the Swift package: open the host dylib at `path` and return its table, or
/// NULL with why in `error`.
const su_cef_api* su_cef_load(const char* path, char* error, size_t error_size);

#ifdef __cplusplus
}
#endif

#endif  // STAGE_CEF_HOST_H
