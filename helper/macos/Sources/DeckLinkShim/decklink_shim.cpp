// The DeckLink half of the shim: the driver, its ports and their modes, a port
// opened for scheduled playback, and devices arriving and going. The scheduler
// itself is output.cpp, shared with the software clock in fake_card.cpp.

#include "decklink_shim.h"

#include "DeckLinkAPIVersion.h"
#include "output.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

// Defined in the vendored DeckLinkAPIDispatch.cpp, which does not declare it in a
// header. It is only meaningful after one of the Create* calls has tried to load
// the framework.
bool IsDeckLinkAPIPresent(void);

using namespace dlshim;

namespace {

bool sameIID(REFIID a, CFUUIDBytes b) { return std::memcmp(&a, &b, sizeof(CFUUIDBytes)) == 0; }

/// A CFString from the driver, as UTF-8, released.
void takeString(CFStringRef s, char *out, size_t outLen) {
  if (outLen > 0) out[0] = 0;
  if (s == nullptr) return;
  CFStringGetCString(s, out, static_cast<CFIndex>(outLen), kCFStringEncodingUTF8);
  CFRelease(s);
}

std::string modeCode(uint32_t mode) {
  char code[5] = {static_cast<char>((mode >> 24) & 0xff), static_cast<char>((mode >> 16) & 0xff),
                  static_cast<char>((mode >> 8) & 0xff), static_cast<char>(mode & 0xff), 0};
  return std::string("'") + code + "'";
}

dl_field fieldOf(BMDFieldDominance d) {
  switch (d) {
    case bmdProgressiveFrame:
      return DL_FIELD_PROGRESSIVE;
    case bmdUpperFieldFirst:
      return DL_FIELD_UPPER_FIRST;
    case bmdLowerFieldFirst:
      return DL_FIELD_LOWER_FIRST;
    case bmdProgressiveSegmentedFrame:
      return DL_FIELD_PSF;
    default:
      return DL_FIELD_UNKNOWN;
  }
}

/// Which port a device is, and whether it can play out at all.
bool readPortId(IDeckLink *device, dl_port_id *id, bool *plays) {
  *id = dl_port_id{};
  *plays = false;
  IDeckLinkProfileAttributes *attributes = nullptr;
  if (device->QueryInterface(IID_IDeckLinkProfileAttributes, reinterpret_cast<void **>(&attributes)) != S_OK) {
    return false;
  }
  int64_t value = 0;
  if (attributes->GetInt(BMDDeckLinkPersistentID, &value) == S_OK) {
    id->has_persistent_id = true;
    id->persistent_id = value;
  }
  if (attributes->GetInt(BMDDeckLinkTopologicalID, &value) == S_OK) {
    id->has_topological_id = true;
    id->topological_id = value;
  }
  if (attributes->GetInt(BMDDeckLinkSubDeviceIndex, &value) == S_OK) id->sub_device = value;
  if (attributes->GetInt(BMDDeckLinkVideoIOSupport, &value) == S_OK) {
    *plays = (value & bmdDeviceSupportsPlayback) != 0;
  }
  attributes->Release();
  return true;
}

bool samePort(const dl_port_id &a, const dl_port_id &b) {
  if (a.sub_device != b.sub_device) return false;
  if (a.has_persistent_id || b.has_persistent_id) {
    return a.has_persistent_id && b.has_persistent_id && a.persistent_id == b.persistent_id;
  }
  return a.has_topological_id && b.has_topological_id && a.topological_id == b.topological_id;
}

/// The device for a port, retained, or nullptr.
IDeckLink *findDevice(const dl_port_id &want) {
  IDeckLinkIterator *iterator = CreateDeckLinkIteratorInstance();
  if (iterator == nullptr) return nullptr;
  IDeckLink *device = nullptr;
  IDeckLink *found = nullptr;
  while (found == nullptr && iterator->Next(&device) == S_OK) {
    dl_port_id id;
    bool plays = false;
    if (readPortId(device, &id, &plays) && plays && samePort(id, want)) {
      found = device;
    } else {
      device->Release();
    }
  }
  iterator->Release();
  return found;
}

// MARK: Completion callbacks

class DeckLinkCard;
/// When `card` finished with `frame`, on the host clock (DeckLinkCard::completedAt).
uint64_t completionTime(DeckLinkCard *card, IDeckLinkVideoFrame *frame);

/// What the driver calls back. Reference counted on its own, because the driver
/// may hold it a moment after the output is gone; `output` is cleared first.
class CompletionSink final : public IDeckLinkVideoOutputCallback {
 public:
  void setOutput(Output *output, DeckLinkCard *card) {
    std::lock_guard<std::mutex> lock(mutex_);
    output_ = output;
    card_ = card;
  }
  void setStopping() { stopping_ = true; }

  HRESULT QueryInterface(REFIID iid, LPVOID *ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (sameIID(iid, IID_IDeckLinkVideoOutputCallback) || sameIID(iid, CFUUIDGetUUIDBytes(IUnknownUUID))) {
      *ppv = static_cast<IDeckLinkVideoOutputCallback *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG AddRef() override { return ++refs_; }
  ULONG Release() override {
    ULONG left = --refs_;
    if (left == 0) delete this;
    return left;
  }

  HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame *frame, BMDOutputFrameCompletionResult result) override {
    Completion c = Completion::completed;
    switch (result) {
      case bmdOutputFrameDisplayedLate:
        c = Completion::late;
        break;
      case bmdOutputFrameDropped:
        c = Completion::dropped;
        break;
      case bmdOutputFrameFlushed:
        c = Completion::flushed;
        break;
      default:
        break;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (output_ != nullptr) output_->completed(frame, c, card_ != nullptr ? completionTime(card_, frame) : 0);
    return S_OK;
  }

  HRESULT ScheduledPlaybackHasStopped() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopping_ && output_ != nullptr) output_->lose("playback stopped");
    return S_OK;
  }

 private:
  ~CompletionSink() override = default;
  std::atomic<ULONG> refs_{1};
  std::mutex mutex_;
  Output *output_ = nullptr;
  DeckLinkCard *card_ = nullptr;
  std::atomic<bool> stopping_{false};
};

class DeckLinkCard final : public Card {
 public:
  DeckLinkCard(IDeckLink *device, IDeckLinkOutput *output, const dl_port_id &id)
      : device_(device), out_(output), id_(id), sink_(new CompletionSink) {}

  ~DeckLinkCard() override {
    stop();
    sink_->Release();
    out_->Release();
    device_->Release();
  }

  const dl_port_id &portId() const { return id_; }
  IDeckLink *device() const { return device_; }

  bool attach(Output *output) override {
    Card::attach(output);
    sink_->setOutput(output, this);
    return out_->SetScheduledFrameCompletionCallback(sink_) == S_OK;
  }

  bool schedule(IDeckLinkVideoFrame *frame, int64_t displayTime, int64_t duration, int64_t timeScale) override {
    return out_->ScheduleVideoFrame(frame, displayTime, duration, timeScale) == S_OK;
  }

  CardFrame createFrame(int32_t width, int32_t height, int32_t rowBytes) override {
    CardFrame made;
    IDeckLinkMutableVideoFrame *frame = nullptr;
    if (out_->CreateVideoFrame(width, height, rowBytes, bmdFormat8BitYUV, bmdFrameFlagDefault, &frame) != S_OK ||
        frame == nullptr) {
      return made;
    }
    void *bytes = nullptr;
    if (frame->GetBytes(&bytes) != S_OK || bytes == nullptr) {
      frame->Release();
      return made;
    }
    made.frame = frame;
    made.bytes = static_cast<uint8_t *>(bytes);
    made.rowBytes = static_cast<int32_t>(frame->GetRowBytes());
    return made;
  }

  /// Where the card's clock is, from the completions (`slotBegan`): asking the
  /// driver (GetScheduledStreamTime) takes 74 us typically and up to 0.8 ms on an 8K
  /// Pro over Thunderbolt, too slow and too uncertain to ask before every begin and
  /// fill. It is asked only until the first completion arrives, and after a run of
  /// completions that disagree with the clock as kept.
  bool hostTimeOf(int64_t streamTime, int64_t timeScale, uint64_t *hostNs) override {
    if (!started_) return false;
    std::unique_lock<std::mutex> lock(clock_);
    if (!anchored_) {
      lock.unlock();
      int64_t stream = 0;
      uint64_t host = 0;
      if (!readClock(timeScale, &stream, &host)) return false;
      lock.lock();
      setAnchor(stream, timeScale, host);
    }
    *hostNs = mapLocked(streamTime, timeScale);
    return true;
  }

  void slotBegan(int64_t streamTime, int64_t timeScale, uint64_t hostNs) override {
    std::lock_guard<std::mutex> lock(clock_);
    if (anchored_) {
      const double off = static_cast<double>(hostNs) - static_cast<double>(mapLocked(streamTime, timeScale));
      // A completion more than a millisecond off is a frame held on, or shown late,
      // not the clock moving: three in a row, and the completions are believed.
      if (off > 1e6 || off < -1e6) {
        if (++disagreements_ < 3) return;
      }
    }
    disagreements_ = 0;
    setAnchor(streamTime, timeScale, hostNs);
  }

  uint64_t minLeadNs() const override { return static_cast<uint64_t>(DL_CARD_MIN_LEAD_US) * 1000; }

  /// When the card finished with `frame`, on the host clock: the driver reports it
  /// in mach_absolute_time already (measured on an 8K Pro with Desktop Video 16.4:
  /// it lands 0.14 ms before the completion callback, while the card's hardware
  /// reference clock is a different clock altogether). 0 when the card cannot say.
  uint64_t completedAt(IDeckLinkVideoFrame *frame) {
    BMDTimeValue done = 0;
    if (out_->GetFrameCompletionReferenceTimestamp(frame, 1000000000, &done) != S_OK || done <= 0) return 0;
    return static_cast<uint64_t>(done);
  }

  bool start(int64_t at, int64_t timeScale) override {
    started_ = out_->StartScheduledPlayback(at, timeScale, 1.0) == S_OK;
    return started_;
  }

  void stop() override {
    if (stopped_) return;
    stopped_ = true;
    sink_->setStopping();
    if (started_) out_->StopScheduledPlayback(0, nullptr, 0);
    out_->SetScheduledFrameCompletionCallback(nullptr);
    // After this nothing reaches the Output, even a completion the driver had
    // already begun to deliver.
    sink_->setOutput(nullptr, nullptr);
    out_->DisableVideoOutput();
  }

 private:
  IDeckLink *device_;
  IDeckLinkOutput *out_;
  dl_port_id id_;
  CompletionSink *sink_;
  /// The playback position and the host clock, read together; of three tries the
  /// quickest, whose middle is surest.
  bool readClock(int64_t timeScale, int64_t *stream, uint64_t *host) {
    uint64_t best = UINT64_MAX;
    for (int i = 0; i < 3; i++) {
      double speed = 0;
      BMDTimeValue now = 0;
      const uint64_t before = hostNowNs();
      if (out_->GetScheduledStreamTime(timeScale, &now, &speed) != S_OK) return false;
      const uint64_t after = hostNowNs();
      if (after - before < best) {
        best = after - before;
        *stream = now;
        *host = before + (after - before) / 2;
      }
    }
    return true;
  }

  void setAnchor(int64_t stream, int64_t scale, uint64_t host) {
    anchorStreamNs_ = static_cast<double>(stream) * 1e9 / static_cast<double>(scale);
    anchorHost_ = host;
    anchored_ = true;
  }

  uint64_t mapLocked(int64_t streamTime, int64_t timeScale) const {
    const double ns = static_cast<double>(streamTime) * 1e9 / static_cast<double>(timeScale);
    return static_cast<uint64_t>(static_cast<double>(anchorHost_) + ns - anchorStreamNs_);
  }

  std::atomic<bool> started_{false};
  bool stopped_ = false;
  std::mutex clock_;
  bool anchored_ = false;
  double anchorStreamNs_ = 0;
  uint64_t anchorHost_ = 0;
  int disagreements_ = 0;
};

uint64_t completionTime(DeckLinkCard *card, IDeckLinkVideoFrame *frame) { return card->completedAt(frame); }

// MARK: Open outputs and device changes

std::mutex gOpenMutex;
std::vector<dl_output *> gOpen;

class DeviceWatch final : public IDeckLinkDeviceNotificationCallback {
 public:
  static DeviceWatch &shared() {
    static DeviceWatch *watch = new DeviceWatch;
    return *watch;
  }

  /// Install the notifications once. False without a driver.
  ///
  /// Its own lock: a driver that reports the devices already present from inside
  /// InstallDeviceNotifications calls notify() on this thread, which takes mutex_.
  bool ensure() {
    std::lock_guard<std::mutex> lock(installMutex_);
    if (discovery_ != nullptr) return true;
    discovery_ = CreateDeckLinkDiscoveryInstance();
    if (discovery_ == nullptr) return false;
    if (discovery_->InstallDeviceNotifications(this) != S_OK) {
      discovery_->Release();
      discovery_ = nullptr;
      return false;
    }
    return true;
  }

  void setListener(dl_devices_changed_fn fn, void *ctx) {
    std::lock_guard<std::mutex> lock(mutex_);
    listener_ = fn;
    ctx_ = ctx;
  }

  HRESULT QueryInterface(REFIID iid, LPVOID *ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (sameIID(iid, IID_IDeckLinkDeviceNotificationCallback) || sameIID(iid, CFUUIDGetUUIDBytes(IUnknownUUID))) {
      *ppv = static_cast<IDeckLinkDeviceNotificationCallback *>(this);
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  // Lives for the process.
  ULONG AddRef() override { return 1; }
  ULONG Release() override { return 1; }

  HRESULT DeckLinkDeviceArrived(IDeckLink *) override {
    notify();
    return S_OK;
  }

  HRESULT DeckLinkDeviceRemoved(IDeckLink *device) override {
    // The device is going, so its attributes may no longer answer: match the
    // object an output was opened on first, and the port id only as a fallback.
    dl_port_id id;
    bool plays = false;
    const bool hasId = device != nullptr && readPortId(device, &id, &plays);
    {
      std::lock_guard<std::mutex> lock(gOpenMutex);
      for (dl_output *open : gOpen) {
        if (open->card->isFake()) continue;
        auto *card = static_cast<DeckLinkCard *>(open->card);
        if (card->device() == device || (hasId && samePort(card->portId(), id))) {
          open->output->lose("the device was removed");
        }
      }
    }
    notify();
    return S_OK;
  }

 private:
  void notify() {
    dl_devices_changed_fn fn = nullptr;
    void *ctx = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      fn = listener_;
      ctx = ctx_;
    }
    if (fn != nullptr) fn(ctx);
  }

  std::mutex installMutex_;
  IDeckLinkDiscovery *discovery_ = nullptr;
  /// Guards the listener only.
  std::mutex mutex_;
  dl_devices_changed_fn listener_ = nullptr;
  void *ctx_ = nullptr;
};

}  // namespace

// MARK: The C API

struct dl_port_list {
  struct Port {
    dl_port_info info;
    std::vector<dl_mode> modes;
  };
  std::vector<Port> ports;
};

extern "C" void dl_driver_get(dl_driver_info *out) {
  *out = dl_driver_info{};
  IDeckLinkAPIInformation *info = CreateDeckLinkAPIInformationInstance();
  if (info == nullptr) {
    // The dispatch found no framework at all, or found one it could not load.
    out->state = IsDeckLinkAPIPresent() ? DL_DRIVER_UNUSABLE : DL_DRIVER_NOT_INSTALLED;
    return;
  }
  int64_t version = 0;
  if (info->GetInt(BMDDeckLinkAPIVersion, &version) == S_OK) out->version = version;
  CFStringRef text = nullptr;
  if (info->GetString(BMDDeckLinkAPIVersion, &text) == S_OK) {
    takeString(text, out->version_string, sizeof out->version_string);
  }
  info->Release();
  out->state =
      (out->version != 0 && out->version < BLACKMAGIC_DECKLINK_API_VERSION) ? DL_DRIVER_TOO_OLD : DL_DRIVER_INSTALLED;
}

extern "C" dl_port_list *dl_port_list_create(void) {
  auto *list = new dl_port_list;
  IDeckLinkIterator *iterator = CreateDeckLinkIteratorInstance();
  if (iterator == nullptr) return list;
  IDeckLink *device = nullptr;
  while (iterator->Next(&device) == S_OK) {
    dl_port_list::Port port{};
    bool plays = false;
    IDeckLinkOutput *output = nullptr;
    if (readPortId(device, &port.info.id, &plays) && plays &&
        device->QueryInterface(IID_IDeckLinkOutput, reinterpret_cast<void **>(&output)) == S_OK) {
      CFStringRef name = nullptr;
      if (device->GetDisplayName(&name) == S_OK) {
        takeString(name, port.info.display_name, sizeof port.info.display_name);
      }
      if (device->GetModelName(&name) == S_OK) takeString(name, port.info.model_name, sizeof port.info.model_name);

      IDeckLinkDisplayModeIterator *modes = nullptr;
      if (output->GetDisplayModeIterator(&modes) == S_OK) {
        IDeckLinkDisplayMode *mode = nullptr;
        while (modes->Next(&mode) == S_OK) {
          dl_mode m{};
          m.display_mode = mode->GetDisplayMode();
          CFStringRef modeName = nullptr;
          if (mode->GetName(&modeName) == S_OK) takeString(modeName, m.name, sizeof m.name);
          m.width = static_cast<int32_t>(mode->GetWidth());
          m.height = static_cast<int32_t>(mode->GetHeight());
          BMDTimeValue duration = 0;
          BMDTimeScale scale = 0;
          if (mode->GetFrameRate(&duration, &scale) == S_OK) {
            m.frame_duration = duration;
            m.time_scale = scale;
          }
          m.field = fieldOf(mode->GetFieldDominance());
          BMDDisplayMode actual = bmdModeUnknown;
          bool supported = false;
          m.yuv8 = output->DoesSupportVideoMode(bmdVideoConnectionUnspecified, m.display_mode, bmdFormat8BitYUV,
                                                bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actual,
                                                &supported) == S_OK &&
                   supported;
          port.modes.push_back(m);
          mode->Release();
        }
        modes->Release();
      }
      port.info.mode_count = static_cast<int32_t>(port.modes.size());
      list->ports.push_back(port);
      output->Release();
    }
    device->Release();
  }
  iterator->Release();
  return list;
}

extern "C" int32_t dl_port_list_count(const dl_port_list *list) {
  return list == nullptr ? 0 : static_cast<int32_t>(list->ports.size());
}

extern "C" bool dl_port_list_port(const dl_port_list *list, int32_t port, dl_port_info *out) {
  if (list == nullptr || port < 0 || port >= static_cast<int32_t>(list->ports.size())) return false;
  *out = list->ports[port].info;
  return true;
}

extern "C" bool dl_port_list_mode(const dl_port_list *list, int32_t port, int32_t mode, dl_mode *out) {
  if (list == nullptr || port < 0 || port >= static_cast<int32_t>(list->ports.size())) return false;
  const auto &modes = list->ports[port].modes;
  if (mode < 0 || mode >= static_cast<int32_t>(modes.size())) return false;
  *out = modes[mode];
  return true;
}

extern "C" void dl_port_list_free(dl_port_list *list) { delete list; }

namespace {

/// Find `port`, check `display_mode` plays in 8-bit YUV, and enable it: a card
/// ready for the pre-roll, or nullptr with the reason.
Card *enablePort(const dl_port_id &port, uint32_t displayMode, std::string &why, Geometry &g) {
  IDeckLink *device = findDevice(port);
  if (device == nullptr) {
    why = "the port is not connected";
    return nullptr;
  }
  IDeckLinkOutput *out = nullptr;
  if (device->QueryInterface(IID_IDeckLinkOutput, reinterpret_cast<void **>(&out)) != S_OK) {
    device->Release();
    why = "the port cannot play out";
    return nullptr;
  }
  auto fail = [&](const std::string &reason) -> Card * {
    out->Release();
    device->Release();
    why = reason;
    return nullptr;
  };

  IDeckLinkDisplayMode *mode = nullptr;
  if (out->GetDisplayMode(displayMode, &mode) != S_OK || mode == nullptr) {
    return fail("the port has no mode " + modeCode(displayMode));
  }
  g.width = static_cast<int32_t>(mode->GetWidth());
  g.height = static_cast<int32_t>(mode->GetHeight());
  BMDTimeValue duration = 0;
  BMDTimeScale scale = 0;
  mode->GetFrameRate(&duration, &scale);
  g.frameDuration = duration;
  g.timeScale = scale;
  mode->Release();

  BMDDisplayMode actual = bmdModeUnknown;
  bool supported = false;
  if (out->DoesSupportVideoMode(bmdVideoConnectionUnspecified, displayMode, bmdFormat8BitYUV,
                                bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actual,
                                &supported) != S_OK ||
      !supported) {
    return fail("the port does not play " + modeCode(displayMode) + " in 8-bit YUV");
  }
  const HRESULT enabled = out->EnableVideoOutput(displayMode, bmdVideoOutputFlagDefault);
  if (enabled == E_ACCESSDENIED) return fail("the port is in use by another application");
  if (enabled != S_OK) return fail("the port refused " + modeCode(displayMode));
  return new DeckLinkCard(device, out, port);
}

}  // namespace

extern "C" dl_output *dl_output_open(const dl_port_id *port, uint32_t display_mode, const dl_callbacks *callbacks,
                                     char *why, size_t why_len) {
  if (port == nullptr || callbacks == nullptr) {
    copyReason("no port or no callbacks", why, why_len);
    return nullptr;
  }
  dl_driver_info driver;
  dl_driver_get(&driver);
  if (driver.state != DL_DRIVER_INSTALLED) {
    copyReason(driver.state == DL_DRIVER_NOT_INSTALLED ? "Desktop Video is not installed"
                                                       : "Desktop Video is too old or did not load",
               why, why_len);
    return nullptr;
  }
  DeviceWatch::shared().ensure();

  std::string reason;
  dl_output *handle = openOutput(
      [&](std::string &whyNot, Geometry &g) { return enablePort(*port, display_mode, whyNot, g); }, *callbacks,
      reason);
  if (handle == nullptr) {
    copyReason(reason, why, why_len);
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(gOpenMutex);
  gOpen.push_back(handle);
  return handle;
}

extern "C" dl_frames dl_output_frames(const dl_output *output) {
  return output != nullptr && output->output->cardFrames() ? DL_FRAMES_CARD : DL_FRAMES_HELPER;
}

extern "C" void dl_output_close(dl_output *output) {
  if (output == nullptr) return;
  {
    std::lock_guard<std::mutex> lock(gOpenMutex);
    gOpen.erase(std::remove(gOpen.begin(), gOpen.end(), output), gOpen.end());
  }
  output->output->close();
  delete output->output;
  delete output->card;
  delete output;
}

extern "C" void dl_output_counters(const dl_output *output, dl_counters *out) {
  *out = dl_counters{};
  if (output != nullptr) output->output->counters(out);
}

extern "C" int32_t dl_output_take_timings(dl_output *output, dl_frame_timing *out, int32_t capacity) {
  if (output == nullptr || out == nullptr || capacity <= 0) return 0;
  return output->output->takeTimings(out, capacity);
}

extern "C" uint64_t dl_host_now_ns(void) { return hostNowNs(); }

extern "C" bool dl_watch_devices(dl_devices_changed_fn changed, void *ctx) {
  DeviceWatch::shared().setListener(changed, ctx);
  return DeviceWatch::shared().ensure();
}
