// A card made of a software clock. It runs the same Output (the same scheduler,
// the same counters) as a DeckLink port, so the timing can be tested, and the
// helper run, without one.
//
// It models what the scheduler depends on:
// - the clock moves one frame per tick, whether or not the host keeps up; a clock
//   that ticks by itself keeps the host's time, one that only tests move keeps its
//   own, slot n beginning at n frame durations, and runs the output's begins and
//   fills as its time passes them;
// - a frame scheduled for a slot that has already begun is never shown, and
//   completes as dropped;
// - a slot with no frame of ours shows the card's last picture again;
// - a frame completes once its slot is over, at the slot boundary (a card's
//   completion time is its hardware's, not the callback's);
// - its playback position, when asked, is the slot on air and when it began; the
//   output keeps the clock from there and from the completions, as for a card
//   (ClockAnchor);
// - completions can be held back, as a host stuck elsewhere would hold them;
// - it can refuse frames it did not make, as a driver that will not take
//   application memory would, and make its own.

#include "output.hpp"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <set>
#include <thread>
#include <utility>

namespace dlshim {

namespace {

std::atomic<int32_t> gCardFramesAlive{0};

/// A frame the software clock made, as a card's CreateVideoFrame would. Its
/// memory is plain malloc, not page-aligned, as nothing promises a card's is.
class FakeCardFrame final : public IDeckLinkMutableVideoFrame {
 public:
  FakeCardFrame(int32_t width, int32_t height, int32_t rowBytes, bool counted)
      : width_(width), height_(height), rowBytes_(rowBytes), counted_(counted),
        bytes_(static_cast<uint8_t *>(std::calloc(static_cast<size_t>(rowBytes) * height, 1))) {
    if (counted_) gCardFramesAlive++;
  }

  bool valid() const { return bytes_ != nullptr; }

  HRESULT QueryInterface(REFIID, LPVOID *ppv) override {
    if (ppv != nullptr) *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG AddRef() override { return ++refs_; }
  ULONG Release() override {
    ULONG left = --refs_;
    if (left == 0) delete this;
    return left;
  }

  long GetWidth() override { return width_; }
  long GetHeight() override { return height_; }
  long GetRowBytes() override { return rowBytes_; }
  BMDPixelFormat GetPixelFormat() override { return bmdFormat8BitYUV; }
  BMDFrameFlags GetFlags() override { return bmdFrameFlagDefault; }
  HRESULT GetBytes(void **buffer) override {
    *buffer = bytes_;
    return S_OK;
  }
  HRESULT GetTimecode(BMDTimecodeFormat, IDeckLinkTimecode **timecode) override {
    *timecode = nullptr;
    return S_FALSE;
  }
  HRESULT GetAncillaryData(IDeckLinkVideoFrameAncillary **ancillary) override {
    *ancillary = nullptr;
    return S_FALSE;
  }
  HRESULT SetFlags(BMDFrameFlags) override { return S_OK; }
  HRESULT SetTimecode(BMDTimecodeFormat, IDeckLinkTimecode *) override { return E_NOTIMPL; }
  HRESULT SetTimecodeFromComponents(BMDTimecodeFormat, uint8_t, uint8_t, uint8_t, uint8_t,
                                    BMDTimecodeFlags) override {
    return E_NOTIMPL;
  }
  HRESULT SetAncillaryData(IDeckLinkVideoFrameAncillary *) override { return E_NOTIMPL; }
  HRESULT SetTimecodeUserBits(BMDTimecodeFormat, BMDTimecodeUserBits) override { return E_NOTIMPL; }

 private:
  ~FakeCardFrame() override {
    std::free(bytes_);
    if (counted_) gCardFramesAlive--;
  }
  std::atomic<ULONG> refs_{1};
  int32_t width_;
  int32_t height_;
  int32_t rowBytes_;
  bool counted_;
  uint8_t *bytes_;
};

class FakeCard final : public Card {
 public:
  FakeCard(int64_t frameDuration, int64_t timeScale, const dl_fake_behaviour &b)
      : frameDuration_(frameDuration),
        timeScale_(timeScale),
        timer_(b.timer),
        refuseHelperFrames_(b.refuse_helper_frames),
        makeNoFrames_(b.make_no_frames),
        countFrames_(b.count_frames),
        clockUnknown_(b.clock_unknown),
        minLeadNs_(static_cast<uint64_t>(std::max<int64_t>(0, b.min_lead_us)) * 1000) {}

  ~FakeCard() override { stop(); }

  bool isFake() const override { return true; }

  bool schedule(IDeckLinkVideoFrame *frame, int64_t displayTime, int64_t, int64_t) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (unplugged_ || stopped_) return false;
    if (refuseHelperFrames_ && made_.count(frame) == 0) return false;
    const int64_t index = floorDiv(displayTime, frameDuration_);
    frame->AddRef();
    pending_.push_back(Pending{frame, index, started_ && index <= onAir_});
    return true;
  }

  uint64_t minLeadNs() const override { return minLeadNs_; }

  CardFrame createFrame(int32_t width, int32_t height, int32_t rowBytes) override {
    CardFrame made;
    if (makeNoFrames_) return made;
    // Rows padded past the picture, as a card may pad them, so the copy that
    // honours the card's row length is the one exercised.
    auto *frame = new FakeCardFrame(width, height, rowBytes + 64, countFrames_);
    if (!frame->valid()) {
      frame->Release();
      return made;
    }
    void *bytes = nullptr;
    frame->GetBytes(&bytes);
    made.frame = frame;
    made.bytes = static_cast<uint8_t *>(bytes);
    made.rowBytes = static_cast<int32_t>(frame->GetRowBytes());
    std::lock_guard<std::mutex> lock(mutex_);
    made_.insert(frame);
    return made;
  }

  /// Where playback is: the slot on air and when it began, as a card's
  /// GetScheduledStreamTime and the host clock read together would say, off by
  /// `readErrorNs_` when a test asks.
  bool readClock(int64_t timeScale, int64_t *stream, uint64_t *host) override {
    clockReads_++;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!started_ || clockUnknown_) return false;
    *stream = onAir_ * frameDuration_ * timeScale / timeScale_;
    *host = static_cast<uint64_t>(static_cast<int64_t>(startNs_ + slotNs(onAir_)) + readErrorNs_);
    return true;
  }

  uint64_t now() override {
    if (timer_) return hostNowNs();
    std::lock_guard<std::mutex> lock(mutex_);
    return virtualNs_;
  }

  bool drivesClock() const override { return !timer_; }

  bool start(int64_t at, int64_t) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      started_ = true;
      onAir_ = floorDiv(at, frameDuration_);
      startNs_ = timer_ ? hostNowNs() : 0;
      virtualNs_ = slotNs(onAir_);
      showLocked();
    }
    if (timer_) thread_ = std::thread([this] { run(); });
    return true;
  }

  void stop() override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopped_) return;
      stopped_ = true;
    }
    wake_.notify_all();
    if (thread_.joinable()) thread_.join();
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto &p : pending_) p.frame->Release();
    pending_.clear();
    for (auto &d : held_) d.first->Release();
    held_.clear();
  }

  void tick(int32_t frames) {
    for (int32_t i = 0; i < frames; i++) tickOnce();
  }

  void hold(bool on) {
    Done done;
    uint64_t at = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      holding_ = on;
      if (!on) done.swap(held_);
      at = timer_ ? hostNowNs() : virtualNs_;
    }
    deliver(done, at);
  }

  void reportLate(int32_t frames) {
    std::lock_guard<std::mutex> lock(mutex_);
    lateReports_ += frames;
  }

  void readError(int64_t us) {
    std::lock_guard<std::mutex> lock(mutex_);
    readErrorNs_ = us * 1000;
  }

  void completionOffset(int64_t us, int32_t count) {
    std::lock_guard<std::mutex> lock(mutex_);
    completionOffsetNs_ = us * 1000;
    offsetCompletions_ = count;
  }

  void unplug() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      unplugged_ = true;
    }
    if (output_ != nullptr) output_->lose("the device was removed");
  }

  int64_t clockReads() const { return clockReads_; }

  int32_t shown(int64_t *pictures, int32_t capacity) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto count = static_cast<int32_t>(shown_.size());
    for (int32_t i = 0; i < count && i < capacity; i++) pictures[i] = shown_[i];
    return count;
  }

 private:
  struct Pending {
    IDeckLinkVideoFrame *frame;
    int64_t index;
    /// Scheduled after its slot began: never shown.
    bool late;
  };
  using Done = std::vector<std::pair<IDeckLinkVideoFrame *, Completion>>;

  static constexpr int64_t kTorn = -2;
  /// Keeps memory bounded on a fake left running for hours.
  static constexpr size_t kShownCap = 1 << 16;

  /// Where slot `index` begins, in nanoseconds since playback began.
  uint64_t slotNs(int64_t index) const {
    return static_cast<uint64_t>(static_cast<double>(index * frameDuration_) * 1e9 / static_cast<double>(timeScale_));
  }

  void tickOnce() {
    // A clock only tests move runs the output's begins and fills that fall before
    // the next slot begins, in order, before the slot changes.
    uint64_t next = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!started_ || stopped_ || unplugged_) return;
      next = startNs_ + slotNs(onAir_ + 1);
    }
    if (!timer_ && output_ != nullptr) output_->runUntil(next);
    Done done;
    uint64_t at = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!started_ || stopped_ || unplugged_) return;
      onAir_++;
      virtualNs_ = next;
      // The slot boundary, as a card's completion timestamp is its hardware's
      // time, not when the callback ran.
      at = next;
      if (offsetCompletions_ > 0) {
        offsetCompletions_--;
        at = static_cast<uint64_t>(static_cast<int64_t>(at) + completionOffsetNs_);
      }
      for (auto it = pending_.begin(); it != pending_.end();) {
        if (it->index < onAir_) {
          Completion result = it->late ? Completion::dropped : Completion::completed;
          if (result == Completion::completed && lateReports_ > 0) {
            lateReports_--;
            result = Completion::late;
          }
          done.emplace_back(it->frame, result);
          it = pending_.erase(it);
        } else {
          ++it;
        }
      }
      showLocked();
      if (holding_) {
        held_.insert(held_.end(), done.begin(), done.end());
        done.clear();
      }
    }
    deliver(done, at);
  }

  /// Record what is on air for the slot that just began: the first eight bytes of
  /// its first line, or kTorn when its last line, found by the frame's own row
  /// length, does not start with the same eight.
  void showLocked() {
    for (const auto &p : pending_) {
      if (p.index == onAir_ && !p.late) {
        void *bytes = nullptr;
        p.frame->GetBytes(&bytes);
        const auto *first = static_cast<const uint8_t *>(bytes);
        const uint8_t *last = first + static_cast<size_t>(p.frame->GetRowBytes()) * (p.frame->GetHeight() - 1);
        int64_t a = 0;
        int64_t b = 0;
        std::memcpy(&a, first, sizeof a);
        std::memcpy(&b, last, sizeof b);
        lastShown_ = a == b ? a : kTorn;
        break;
      }
    }
    if (shown_.size() < kShownCap) shown_.push_back(lastShown_);
  }

  /// A software clock has no completion timestamps of its own to report: the
  /// slot boundary it ticked at stands in.
  void deliver(Done &done, uint64_t at) {
    for (auto &d : done) {
      if (output_ != nullptr) output_->completed(d.first, d.second, at);
      d.first->Release();
    }
  }

  void run() {
    for (int64_t k = onAir_ + 1;; k++) {
      const uint64_t due = startNs_ + slotNs(k);
      {
        std::unique_lock<std::mutex> lock(mutex_);
        const uint64_t now = hostNowNs();
        if (now < due && wake_.wait_for(lock, std::chrono::nanoseconds(due - now), [this] { return stopped_; })) {
          return;
        }
        if (stopped_) return;
      }
      tickOnce();
    }
  }

  const int64_t frameDuration_;
  const int64_t timeScale_;
  const bool timer_;
  const bool refuseHelperFrames_;
  const bool makeNoFrames_;
  const bool countFrames_;
  const bool clockUnknown_;
  const uint64_t minLeadNs_;
  /// The frames this card made; only compared, never dereferenced.
  std::set<const IDeckLinkVideoFrame *> made_;

  std::mutex mutex_;
  std::condition_variable wake_;
  std::thread thread_;
  std::vector<Pending> pending_;
  Done held_;
  std::vector<int64_t> shown_;
  int64_t onAir_ = 0;
  std::atomic<int64_t> clockReads_{0};
  /// The host time playback began at; 0 for a clock only tests move.
  uint64_t startNs_ = 0;
  /// A clock only tests move: where its time is.
  uint64_t virtualNs_ = 0;
  int64_t lastShown_ = -1;
  bool started_ = false;
  bool stopped_ = false;
  bool holding_ = false;
  bool unplugged_ = false;
  /// Completions still to be reported late although they were shown on time, as a
  /// card under load reports them.
  int32_t lateReports_ = 0;
  /// Added to the host time a read of the clock reports.
  int64_t readErrorNs_ = 0;
  /// Added to the next `offsetCompletions_` completion times.
  int64_t completionOffsetNs_ = 0;
  int32_t offsetCompletions_ = 0;
};

FakeCard *fakeOf(const dl_output *output) {
  if (output == nullptr || !output->card->isFake()) return nullptr;
  return static_cast<FakeCard *>(output->card);
}

}  // namespace

}  // namespace dlshim

using namespace dlshim;

extern "C" dl_output *dl_fake_output_open(int32_t width, int32_t height, int64_t frame_duration, int64_t time_scale,
                                          const dl_fake_behaviour *behaviour, const dl_callbacks *callbacks,
                                          char *why, size_t why_len) {
  if (callbacks == nullptr || behaviour == nullptr) {
    copyReason("no callbacks or no behaviour", why, why_len);
    return nullptr;
  }
  const dl_fake_behaviour b = *behaviour;
  std::string reason;
  dl_output *handle = openOutput(
      [&](std::string &, Geometry &g) -> Card * {
        g = Geometry{width, height, frame_duration, time_scale};
        return new FakeCard(frame_duration, time_scale, b);
      },
      *callbacks, reason);
  if (handle == nullptr) copyReason(reason, why, why_len);
  return handle;
}

extern "C" int32_t dl_fake_card_frames_alive(void) { return gCardFramesAlive; }

extern "C" int64_t dl_fake_clock_reads(const dl_output *output) {
  if (auto *fake = fakeOf(output)) return fake->clockReads();
  return 0;
}

extern "C" void dl_fake_tick(dl_output *output, int32_t frames) {
  if (auto *fake = fakeOf(output)) fake->tick(frames);
}

extern "C" void dl_fake_hold_completions(dl_output *output, bool hold) {
  if (auto *fake = fakeOf(output)) fake->hold(hold);
}

extern "C" void dl_fake_report_late(dl_output *output, int32_t frames) {
  if (auto *fake = fakeOf(output)) fake->reportLate(frames);
}

extern "C" void dl_fake_unplug(dl_output *output) {
  if (auto *fake = fakeOf(output)) fake->unplug();
}

extern "C" void dl_fake_clock_read_error(dl_output *output, int64_t us) {
  if (auto *fake = fakeOf(output)) fake->readError(us);
}

extern "C" void dl_fake_completion_offset(dl_output *output, int64_t us, int32_t count) {
  if (auto *fake = fakeOf(output)) fake->completionOffset(us, count);
}

extern "C" int32_t dl_fake_shown(const dl_output *output, int64_t *pictures, int32_t capacity) {
  if (auto *fake = fakeOf(output)) return fake->shown(pictures, capacity);
  return 0;
}
