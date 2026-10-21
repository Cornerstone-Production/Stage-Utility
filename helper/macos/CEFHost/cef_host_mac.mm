// The browser host: CEF behind the C API in stage_cef_host.h.
//
// Built by CMakeLists.txt beside this file into libStageUtilityCEFHost.dylib, with
// libcef_dll_wrapper linked in statically. The Swift app opens it at run time.

#import <Cocoa/Cocoa.h>
#include <IOSurface/IOSurface.h>
#include <objc/message.h>
#include <mach-o/dyld.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_application_mac.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_parser.h"
#include "include/cef_version.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_library_loader.h"

#include "stage_cef_host.h"

// MARK: The application class

// CEF on macOS needs NSApp to be an NSApplication that conforms to CefAppProtocol,
// so Chromium knows when AppKit is inside -sendEvent:.
@interface StageUtilityCEFApplication : NSApplication <CefAppProtocol> {
 @private
  BOOL handlingSendEvent_;
}
@end

@implementation StageUtilityCEFApplication
- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  handlingSendEvent_ = handlingSendEvent;
}
- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sendingEventScoper;
  [super sendEvent:event];
}

// Every orderly quit reaches an app through -terminate:: the Quit item, a quit Apple
// event, and logout, restart and shutdown. AppKit's own ends the process with exit()
// from inside the run loop, which Chromium cannot shut down from; and a delegate
// that answers NSTerminateCancel to put that off has macOS report that the app
// cancelled the logout or restart. So, as Chromium's own apps do (cefclient's
// ClientApplication), -terminate: asks the delegate to close everything
// (-tryToTerminateApplication:, which returns YES when it has started) and returns.
// The delegate ends CEF's loop once every browser has closed, and the process exits
// from main. A delegate that does not take it (Chromium not running) gets AppKit's.
- (void)terminate:(id)sender {
  id delegate = [self delegate];
  SEL ask = NSSelectorFromString(@"tryToTerminateApplication:");
  if ([delegate respondsToSelector:ask]) {
    BOOL (*send)(id, SEL, id) = (BOOL (*)(id, SEL, id))objc_msgSend;
    if (send(delegate, ask, self)) return;
  }
  [super terminate:sender];
}
@end

namespace {

void CopyError(char* error, size_t size, const std::string& text) {
  if (error && size) snprintf(error, size, "%s", text.c_str());
}

class Client;

// Every open browser, so the app can close them all before it quits.
std::set<su_browser*> g_open;
bool g_quitting = false;
CefScopedLibraryLoader* g_library = nullptr;

void QuitIfDone() {
  if (g_quitting && g_open.empty()) {
    g_quitting = false;
    CefQuitMessageLoop();
  }
}

}  // namespace

struct su_browser {
  CefRefPtr<Client> client;
  // Read by begin_frame from a clock's queue; written on the UI thread.
  std::mutex lock;
  CefRefPtr<CefBrowserHost> host;
};

namespace {

class App : public CefApp, public CefBrowserProcessHandler {
 public:
  App(void* context, void (*initialized)(void*), std::vector<std::string> switches)
      : context_(context), initialized_(initialized), switches_(std::move(switches)) {}

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }

  // The app's switches (ChromiumSwitches in the Swift core says what each is for),
  // for the browser process only: Chromium hands its children what they need.
  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override {
    if (!process_type.empty()) return;
    for (const std::string& s : switches_) {
      size_t eq = s.find('=');
      if (eq == std::string::npos) {
        command_line->AppendSwitch(s);
      } else {
        command_line->AppendSwitchWithValue(s.substr(0, eq), s.substr(eq + 1));
      }
    }
  }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    if (initialized_) initialized_(context_);
  }

 private:
  void* context_;
  void (*initialized_)(void*);
  std::vector<std::string> switches_;
  IMPLEMENT_REFCOUNTING(App);
};

class Client : public CefClient,
               public CefLoadHandler,
               public CefRequestHandler,
               public CefLifeSpanHandler,
               public CefRenderHandler,
               public CefContextMenuHandler,
               public CefJSDialogHandler,
               public CefDevToolsMessageObserver {
 public:
  Client(su_browser* owner, const su_browser_events& events, bool windowless, int width, int height)
      : owner_(owner), events_(events), windowless_(windowless), width_(width), height_(height) {}

  // Stops every callback into the app. After this the client only finishes closing.
  void Detach() { detached_ = true; }

  void Resize(int width, int height) {
    width_ = width;
    height_ = height;
  }

  void DevTools(CefRefPtr<CefBrowser> browser, const char* method, const char* params_json, void* context,
                su_devtools_done done) {
    if (!registration_) registration_ = browser->GetHost()->AddDevToolsMessageObserver(this);
    CefRefPtr<CefDictionaryValue> params;
    if (params_json) {
      CefRefPtr<CefValue> value = CefParseJSON(params_json, JSON_PARSER_RFC);
      if (!value || value->GetType() != VTYPE_DICTIONARY) {
        done(context, nullptr, 0, "the DevTools parameters are not a JSON object");
        return;
      }
      params = value->GetDictionary();
    }
    int id = browser->GetHost()->ExecuteDevToolsMethod(0, method, params);
    if (id == 0) {
      std::string why = std::string("DevTools did not accept ") + method;
      done(context, nullptr, 0, why.c_str());
      return;
    }
    pending_[id] = {context, done};
  }

  // CefClient
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return windowless_ ? this : nullptr; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  CefRefPtr<CefJSDialogHandler> GetJSDialogHandler() override { return this; }

  // CefLoadHandler
  void OnLoadStart(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, TransitionType) override {
    if (!frame->IsMain()) return;
    // The entry on screen now is the one that committed, with its response status.
    int status = 0;
    if (CefRefPtr<CefNavigationEntry> entry = browser->GetHost()->GetVisibleNavigationEntry())
      status = entry->GetHttpStatusCode();
    std::string url = frame->GetURL().ToString();
    // A page committed, and it is the app's to show, unless it is Chromium's error
    // page for the load that just failed: that carries the failed address and no
    // HTTP status (CEF documents OnLoadStart with OnLoadError for a failure after
    // commit). The same address answered by the server has a status.
    if (!(blanked_ && status == 0 && url == failed_url_)) Blank(browser, false);
    if (detached_ || !events_.committed) return;
    events_.committed(events_.context, url.c_str(), status);
  }

  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int status) override {
    if (detached_ || !frame->IsMain() || !events_.finished) return;
    events_.finished(events_.context, status);
  }

  void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, ErrorCode code, const CefString& text,
                   const CefString& failed_url) override {
    // Chromium commits its own error page for a failed load, and that page prints
    // the whole address it could not load: an output's token, on air. Nothing of it
    // is shown. The app loads its own page in its place from `failed`, and that
    // page's commit (OnLoadStart) shows the browser again. ERR_ABORTED commits no
    // error page: it is a load replaced by another.
    if (frame->IsMain() && code != ERR_ABORTED) {
      failed_url_ = failed_url.ToString();
      Blank(browser, true);
    }
    if (detached_ || !frame->IsMain() || !events_.failed) return;
    std::string t = text.ToString(), u = failed_url.ToString();
    events_.failed(events_.context, static_cast<int>(code), t.c_str(), u.c_str());
  }

  // CefRequestHandler
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser>, TerminationStatus status, int error_code,
                                 const CefString& error_string) override {
    if (detached_ || !events_.process_gone) return;
    std::string t = error_string.ToString();
    events_.process_gone(events_.context, static_cast<int>(status), error_code, t.c_str());
  }

  // CefLifeSpanHandler
  bool OnBeforePopup(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, int, const CefString&, const CefString&,
                     WindowOpenDisposition, bool, const CefPopupFeatures&, CefWindowInfo&, CefRefPtr<CefClient>&,
                     CefBrowserSettings&, CefRefPtr<CefDictionaryValue>&, bool*) override {
    // An output has no room for a second window: window.open does nothing.
    return true;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser>) override {
    registration_ = nullptr;
    for (auto& c : pending_) c.second.done(c.second.context, nullptr, 0, "the browser closed");
    pending_.clear();
    g_open.erase(owner_);
    delete owner_;
    owner_ = nullptr;
    QuitIfDone();
  }

  // CefRenderHandler (windowless only)
  void GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override { rect = CefRect(0, 0, width_, height_); }

  bool GetScreenInfo(CefRefPtr<CefBrowser>, CefScreenInfo& info) override {
    // One page pixel is one output pixel.
    info.device_scale_factor = 1.0f;
    info.depth = 24;
    info.depth_per_component = 8;
    info.is_monochrome = false;
    info.rect = CefRect(0, 0, width_, height_);
    info.available_rect = info.rect;
    return true;
  }

  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType, const RectList&, const void*, int, int) override {}

  void OnAcceleratedPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList&,
                          const CefAcceleratedPaintInfo& info) override {
    // A card output repeats its last picture meanwhile.
    if (blanked_) return;
    if (detached_ || type != PET_VIEW || !events_.painted || !info.shared_texture_io_surface) return;
    events_.painted(events_.context, info.shared_texture_io_surface);
  }

  // CefContextMenuHandler: an output is not a browser; a right-click on a control
  // surface opens nothing.
  void OnBeforeContextMenu(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefContextMenuParams>,
                           CefRefPtr<CefMenuModel> model) override {
    model->Clear();
  }

  // CefJSDialogHandler: nobody is there to dismiss an alert().
  bool OnJSDialog(CefRefPtr<CefBrowser>, const CefString&, JSDialogType, const CefString&, const CefString&,
                  CefRefPtr<CefJSDialogCallback>, bool& suppress_message) override {
    suppress_message = true;
    return false;
  }

  bool OnBeforeUnloadDialog(CefRefPtr<CefBrowser>, const CefString&, bool,
                            CefRefPtr<CefJSDialogCallback> callback) override {
    callback->Continue(true, CefString());
    return true;
  }

  // CefDevToolsMessageObserver
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int message_id, bool success, const void* result,
                              size_t result_size) override {
    auto it = pending_.find(message_id);
    if (it == pending_.end()) return;
    Pending p = it->second;
    pending_.erase(it);
    // Called even after Detach: `done` always runs exactly once, so whatever the
    // app holds for it is released.
    if (success) {
      p.done(p.context, static_cast<const char*>(result), result_size, nullptr);
    } else {
      std::string why(static_cast<const char*>(result), result_size);
      p.done(p.context, nullptr, 0, why.c_str());
    }
  }

 private:
  struct Pending {
    void* context;
    su_devtools_done done;
  };

  // While Chromium's error page is the committed page: a windowless browser's
  // pictures are dropped, and a windowed browser's view is hidden, so the output
  // shows its window's black. Set and cleared on the UI thread.
  void Blank(CefRefPtr<CefBrowser> browser, bool on) {
    if (blanked_ == on) return;
    blanked_ = on;
    if (windowless_) return;
    NSView* view = (__bridge NSView*)browser->GetHost()->GetWindowHandle();
    view.hidden = on ? YES : NO;
  }

  su_browser* owner_;
  su_browser_events events_;
  bool windowless_;
  std::atomic<bool> blanked_{false};
  // The address whose load failed last, while blanked: its error page must not unblank.
  std::string failed_url_;
  std::atomic<int> width_, height_;
  bool detached_ = false;
  CefRefPtr<CefRegistration> registration_;
  std::map<int, Pending> pending_;
  IMPLEMENT_REFCOUNTING(Client);
};

CefRefPtr<CefBrowserHost> HostOf(su_browser* b) {
  std::lock_guard<std::mutex> guard(b->lock);
  return b->host;
}

CefBrowserSettings BlackSettings() {
  CefBrowserSettings settings;
  settings.background_color = CefColorSetARGB(255, 0, 0, 0);
  return settings;
}

su_browser* Register(su_browser* b, CefRefPtr<CefBrowser> browser) {
  if (!browser) {
    delete b;
    return nullptr;
  }
  {
    std::lock_guard<std::mutex> guard(b->lock);
    b->host = browser->GetHost();
  }
  g_open.insert(b);
  return b;
}

// MARK: The table

const char* CefVersion() { return CEF_VERSION; }

bool Sandboxed() {
#if defined(CEF_USE_SANDBOX)
  return true;
#else
  return false;
#endif
}

const char* ApplicationClassName() { return "StageUtilityCEFApplication"; }

bool Initialize(const su_cef_settings* s, char* error, size_t error_size) {
  if (![NSApp isKindOfClass:[StageUtilityCEFApplication class]]) {
    CopyError(error, error_size, "the app was not made from StageUtilityCEFApplication");
    return false;
  }
  g_library = new CefScopedLibraryLoader();
  if (!g_library->LoadInMain()) {
    CopyError(error, error_size, "could not load Chromium Embedded Framework.framework from the app's Frameworks folder");
    return false;
  }
  // Chromium reads its own switches from the command line; the app's flags (and a
  // bare number after one of them) are not for it, so it gets the executable alone.
  char path[4096];
  uint32_t size = sizeof(path);
  if (_NSGetExecutablePath(path, &size) != 0) {
    CopyError(error, error_size, "could not read the executable's path");
    return false;
  }
  static char* argv[] = {strdup(path), nullptr};
  CefMainArgs args(1, argv);

  CefSettings settings;
  settings.no_sandbox = !Sandboxed();
  settings.windowless_rendering_enabled = true;
  settings.log_severity = LOGSEVERITY_WARNING;
  settings.background_color = CefColorSetARGB(255, 0, 0, 0);
  if (s->cache_path) {
    CefString(&settings.root_cache_path) = s->cache_path;
    CefString(&settings.cache_path) = s->cache_path;
  }
  if (s->log_file) CefString(&settings.log_file) = s->log_file;

  std::vector<std::string> switches;
  for (size_t i = 0; i < s->switch_count; i++) {
    if (s->switches[i]) switches.emplace_back(s->switches[i]);
  }
  CefRefPtr<App> app(new App(s->context, s->context_initialized, std::move(switches)));
  if (!CefInitialize(args, settings, app.get(), nullptr)) {
    CopyError(error, error_size, "CefInitialize failed, exit code " + std::to_string(CefGetExitCode()));
    return false;
  }
  return true;
}

void RunMessageLoop() { CefRunMessageLoop(); }

void QuitWhenClosed() {
  CEF_REQUIRE_UI_THREAD();
  g_quitting = true;
  std::vector<su_browser*> open(g_open.begin(), g_open.end());
  for (su_browser* b : open) {
    b->client->Detach();
    if (CefRefPtr<CefBrowserHost> host = HostOf(b)) host->CloseBrowser(true);
  }
  QuitIfDone();
  // A browser that never says it closed must not keep the app from quitting.
  CefPostDelayedTask(TID_UI, base::BindOnce([] {
                       if (g_quitting) {
                         g_quitting = false;
                         CefQuitMessageLoop();
                       }
                     }),
                     3000);
}

void Shutdown() { CefShutdown(); }

su_browser* CreateWindowed(void* parent, const char* url, const su_browser_events* events) {
  CEF_REQUIRE_UI_THREAD();
  NSView* view = (__bridge NSView*)parent;
  NSRect bounds = view.bounds;
  CefWindowInfo info;
  info.SetAsChild((__bridge CefWindowHandle)view,
                  CefRect(0, 0, (int)bounds.size.width, (int)bounds.size.height));
  su_browser* b = new su_browser();
  b->client = new Client(b, *events, false, (int)bounds.size.width, (int)bounds.size.height);
  return Register(b, CefBrowserHost::CreateBrowserSync(info, b->client, url ? url : "about:blank",
                                                       BlackSettings(), nullptr, nullptr));
}

su_browser* CreateWindowless(int width, int height, const char* url, const su_browser_events* events) {
  CEF_REQUIRE_UI_THREAD();
  CefWindowInfo info;
  info.SetAsWindowless(nullptr);
  info.shared_texture_enabled = true;
  info.external_begin_frame_enabled = true;
  CefBrowserSettings settings = BlackSettings();
  // Frames come from begin_frame; this is the most often Chromium's capture of the
  // page may hand one over (its minimum capture period, 1 ms here). At 60 or 120 it
  // held back the picture for the frame after a page change, until after the card
  // needed it, a repeat every time a clock ticked (DECKLINK.md, "Latency").
  settings.windowless_frame_rate = 1000;
  su_browser* b = new su_browser();
  b->client = new Client(b, *events, true, width, height);
  return Register(b, CefBrowserHost::CreateBrowserSync(info, b->client, url ? url : "about:blank", settings,
                                                       nullptr, nullptr));
}

void Load(su_browser* b, const char* url) {
  if (CefRefPtr<CefBrowserHost> host = HostOf(b)) host->GetBrowser()->GetMainFrame()->LoadURL(url);
}

void Reload(su_browser* b) {
  if (CefRefPtr<CefBrowserHost> host = HostOf(b)) host->GetBrowser()->ReloadIgnoreCache();
}

void Resize(su_browser* b, int width, int height) {
  b->client->Resize(width, height);
  if (CefRefPtr<CefBrowserHost> host = HostOf(b)) {
    if (host->IsWindowRenderingDisabled()) {
      host->NotifyScreenInfoChanged();
      host->WasResized();
    }
  }
}

void BeginFrame(su_browser* b) {
  CefRefPtr<CefBrowserHost> host = HostOf(b);
  if (!host) return;
  // A page that has not changed would otherwise paint nothing, and a frame clock
  // could not tell "nothing changed" from "the page is late". Invalidating asks
  // Chromium's capture for a picture of the page as it is (RequestRefreshFrame), so
  // every begin frame hands one over, a few hundred microseconds later when nothing
  // changed.
  host->Invalidate(PET_VIEW);
  host->SendExternalBeginFrame();
}

void DevTools(su_browser* b, const char* method, const char* params_json, void* context, su_devtools_done done) {
  CefRefPtr<CefBrowserHost> host = HostOf(b);
  if (!host) {
    done(context, nullptr, 0, "the browser is closed");
    return;
  }
  b->client->DevTools(host->GetBrowser(), method, params_json, context, done);
}

void Close(su_browser* b) {
  CEF_REQUIRE_UI_THREAD();
  b->client->Detach();
  CefRefPtr<CefBrowserHost> host;
  {
    std::lock_guard<std::mutex> guard(b->lock);
    host.swap(b->host);
  }
  // b is freed in OnBeforeClose.
  if (host) host->CloseBrowser(true);
}

const su_cef_api kApi = {
    SU_CEF_API_VERSION, CefVersion,     Sandboxed,      ApplicationClassName, Initialize,
    RunMessageLoop,     QuitWhenClosed, Shutdown,       CreateWindowed,       CreateWindowless,
    Load,               Reload,         Resize,         BeginFrame,           DevTools,
    Close,
};

}  // namespace

extern "C" __attribute__((visibility("default"))) const su_cef_api* su_cef_host_api(void) {
  return &kApi;
}
