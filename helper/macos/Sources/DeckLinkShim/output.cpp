#include "output.hpp"

#include <cstdio>
#include <cstring>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#include <pthread.h>

#include <algorithm>
#include <chrono>

namespace dlshim {

void copyReason(const std::string &reason, char *why, size_t whyLen) {
  if (why == nullptr || whyLen == 0) return;
  std::snprintf(why, whyLen, "%s", reason.c_str());
}

// MARK: PoolFrame

PoolFrame::PoolFrame(int32_t width, int32_t height, int32_t slot)
    : width_(width), height_(height), rowBytes_(width * 2), slot_(slot) {
  const size_t page = vm_page_size;
  const size_t used = static_cast<size_t>(rowBytes_) * static_cast<size_t>(height_);
  length_ = (used + page - 1) / page * page;
  vm_address_t address = 0;
  // Zeroed, in whole pages, from vm_allocate.
  if (vm_allocate(mach_task_self(), &address, length_, VM_FLAGS_ANYWHERE) == KERN_SUCCESS) {
    bytes_ = reinterpret_cast<uint8_t *>(address);
    fillBlack();
  } else {
    length_ = 0;
  }
}

PoolFrame::~PoolFrame() {
  if (bytes_ != nullptr) vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(bytes_), length_);
}

void fillBlack(uint8_t *bytes, int32_t rowBytes, int32_t width, int32_t height) {
  for (int32_t y = 0; y < height; y++) {
    uint8_t *row = bytes + static_cast<size_t>(y) * rowBytes;
    for (int32_t x = 0; x < width * 2; x += 4) {
      row[x] = 128;
      row[x + 1] = 16;
      row[x + 2] = 128;
      row[x + 3] = 16;
    }
  }
}

void PoolFrame::fillBlack() { dlshim::fillBlack(bytes_, rowBytes_, width_, height_); }

HRESULT PoolFrame::QueryInterface(REFIID iid, LPVOID *ppv) {
  if (ppv == nullptr) return E_POINTER;
  if (sameIID(iid, IID_IDeckLinkVideoFrame) || sameIID(iid, CFUUIDGetUUIDBytes(IUnknownUUID))) {
    *ppv = static_cast<IDeckLinkVideoFrame *>(this);
    AddRef();
    return S_OK;
  }
  *ppv = nullptr;
  return E_NOINTERFACE;
}

ULONG PoolFrame::AddRef() { return ++refs_; }

ULONG PoolFrame::Release() {
  ULONG left = --refs_;
  if (left == 0) delete this;
  return left;
}

HRESULT PoolFrame::GetBytes(void **buffer) {
  if (buffer == nullptr) return E_POINTER;
  *buffer = bytes_;
  return S_OK;
}

HRESULT PoolFrame::GetTimecode(BMDTimecodeFormat, IDeckLinkTimecode **timecode) {
  if (timecode != nullptr) *timecode = nullptr;
  return S_FALSE;
}

HRESULT PoolFrame::GetAncillaryData(IDeckLinkVideoFrameAncillary **ancillary) {
  if (ancillary != nullptr) *ancillary = nullptr;
  return S_FALSE;
}

// MARK: The host clock

namespace {
const mach_timebase_info_data_t &timebase() {
  static const mach_timebase_info_data_t base = [] {
    mach_timebase_info_data_t b;
    mach_timebase_info(&b);
    return b;
  }();
  return base;
}

/// The last stretch of a wait slept precisely (see clockLoop).
constexpr uint64_t kPreciseNs = 4000000;

/// Host nanoseconds as mach_absolute_time ticks, for mach_wait_until.
uint64_t hostTicksAt(uint64_t ns) { return ns * timebase().denom / timebase().numer; }
}  // namespace

uint64_t hostNowNs() { return mach_absolute_time() * timebase().numer / timebase().denom; }

// MARK: Output

Output::Output(Card *card, int32_t width, int32_t height, int64_t frameDuration, int64_t timeScale,
               const dl_callbacks &callbacks, bool cardFrames)
    : card_(card),
      width_(width),
      height_(height),
      frameDuration_(frameDuration),
      timeScale_(timeScale),
      callbacks_(callbacks),
      cardFrames_(cardFrames) {
  if (callbacks_.depth == 0) callbacks_.depth = 3;
  headStartNs_ = static_cast<uint64_t>(callbacks_.head_start_us > 0 ? callbacks_.head_start_us
                                                                     : DL_DEFAULT_HEAD_START_US) * 1000;
  fillLeadNs_ = static_cast<uint64_t>(callbacks_.fill_lead_us > 0 ? callbacks_.fill_lead_us
                                                                   : DL_DEFAULT_FILL_LEAD_US) * 1000;
  attached_ = card_->attach(this);
}

Output::~Output() {
  for (Slot &slot : slots_) {
    if (slot.card.frame != nullptr) slot.card.frame->Release();
    if (slot.staging != nullptr) slot.staging->Release();
  }
}

bool Output::start(std::string &why) {
  if (width_ <= 0 || height_ <= 0 || width_ % 2 != 0) {
    why = "the frame size " + std::to_string(width_) + "x" + std::to_string(height_) +
          " is not a whole number of UYVY pixel pairs";
    return false;
  }
  if (frameDuration_ <= 0 || timeScale_ <= 0) {
    why = "the mode has no frame rate";
    return false;
  }
  if (!attached_) {
    why = "the card would not take the completion callback";
    return false;
  }
  if (callbacks_.depth < 2) {
    why = "an output needs at least two frames";
    return false;
  }
  if (headStartNs_ <= fillLeadNs_) {
    why = "the head start is not longer than the fill lead, so no picture could be ready in time";
    return false;
  }
  for (int32_t n = 0; n < callbacks_.depth; n++) {
    Slot slot;
    if (cardFrames_) {
      slot.card = card_->createFrame(width_, height_, width_ * 2);
      if (slot.card.frame == nullptr || slot.card.bytes == nullptr || slot.card.rowBytes < width_ * 2) {
        if (slot.card.frame != nullptr) slot.card.frame->Release();
        cardFramesUnavailable_ = true;
        why = "the card would not make a frame";
        return false;
      }
      fillBlack(slot.card.bytes, slot.card.rowBytes, width_, height_);
    } else {
      slot.staging = new PoolFrame(width_, height_, n);
      if (!slot.staging->valid()) {
        slot.staging->Release();
        why = "could not allocate a frame";
        return false;
      }
    }
    slots_.push_back(slot);
  }
  // The pre-roll: before the card's clock runs, with whatever picture is there.
  {
    std::lock_guard<std::mutex> work(work_);
    const int32_t preroll = std::min<int32_t>(static_cast<int32_t>(kPreroll), callbacks_.depth);
    for (int32_t n = 0; n < preroll; n++) {
      if (!fillAndSchedule(slots_[n], n, 0, 0)) {
        why = helperFramesRefused_ ? "the card refused the helper's own frames" : "the card refused the pre-roll";
        return false;
      }
    }
    nextBegin_ = nextFill_ = preroll;
  }
  if (!card_->start(0, timeScale_)) {
    why = "the card would not start playback";
    return false;
  }
  started_ = true;
  if (!card_->drivesClock()) clock_ = std::thread([this] { clockLoop(); });
  return true;
}

bool Output::airOf(int64_t index, uint64_t *at) {
  return card_->hostTimeOf(index * frameDuration_, timeScale_, at);
}

Output::Event Output::nextEvent(uint64_t *at) {
  uint64_t fillAir = 0;
  if (!airOf(nextFill_, &fillAir)) return Event::none;
  const uint64_t fillAt = fillAir - std::min(fillAir, fillLeadNs_);
  if (callbacks_.begin != nullptr && nextBegin_ >= nextFill_) {
    uint64_t beginAir = 0;
    if (airOf(nextBegin_, &beginAir)) {
      const uint64_t beginAt = beginAir - std::min(beginAir, headStartNs_);
      if (beginAt < fillAt) {
        *at = beginAt;
        return Event::begin;
      }
    }
  }
  *at = fillAt;
  return Event::fill;
}

void Output::run(Event event, uint64_t now) {
  std::lock_guard<std::mutex> work(work_);
  if (closing_ || lost_) return;
  if (event == Event::begin) {
    begin(now);
  } else if (event == Event::fill) {
    fill(now);
  }
}

void Output::begin(uint64_t now) {
  // A thread woken late asks only for the latest frame whose time to be asked for
  // has come: the ones before it would not be ready any sooner.
  int64_t index = nextBegin_;
  for (;;) {
    uint64_t air = 0;
    if (!airOf(index + 1, &air) || air - std::min(air, headStartNs_) > now) break;
    index++;
  }
  nextBegin_ = index + 1;
  callbacks_.begin(callbacks_.ctx, index, index * frameDuration_);
}

void Output::fill(uint64_t now) {
  const int64_t index = nextFill_++;
  if (nextBegin_ < nextFill_) nextBegin_ = nextFill_;
  uint64_t air = 0;
  airOf(index, &air);
  // Too late for the card to show it on time: skipped, and the card holds the
  // picture before. Scheduling it anyway would have it shown late, or dropped.
  if (now + card_->minLeadNs() > air) {
    skip(index, air, 0);
    return;
  }
  Slot *free = nullptr;
  {
    std::lock_guard<std::mutex> lock(state_);
    // The slot carrying the last picture may be refilled once the card has given
    // it back: a repeat into it is already there, and a new picture is written over
    // memory the card is done with.
    for (Slot &slot : slots_) {
      if (!slot.busy) {
        free = &slot;
        free->busy = true;
        break;
      }
    }
  }
  // Every frame is still with the card: its completions are late.
  if (free == nullptr) {
    skip(index, air, 1);
    return;
  }
  if (!fillAndSchedule(*free, index, now, air)) {
    std::lock_guard<std::mutex> lock(state_);
    free->busy = false;
  }
}

void Output::skip(int64_t index, uint64_t air, int32_t why) {
  skipped_++;
  if (!skipping_) resyncs_++;
  skipping_ = true;
  dl_frame_timing t{};
  t.index = index;
  t.skipped = true;
  t.result = why;
  t.air_ns = air;
  t.fill_ns = card_->now();
  std::lock_guard<std::mutex> lock(state_);
  keep(t);
}

bool Output::fillAndSchedule(Slot &slot, int64_t index, uint64_t now, uint64_t air) {
  const int64_t at = index * frameDuration_;
  const size_t length = slot.staging != nullptr ? slot.staging->length()
                                                : static_cast<size_t>(slot.rowBytes()) * static_cast<size_t>(height_);
  dl_frame_target target{slot.bytes(), length, slot.rowBytes(), width_, height_,
                         static_cast<int32_t>(&slot - slots_.data()), 0, 0, 0, 0};
  const bool fresh = callbacks_.fill != nullptr && callbacks_.fill(callbacks_.ctx, index, at, &target);
  dl_frame_timing timing{};
  timing.index = index;
  timing.fresh = fresh;
  timing.fill_ns = now;
  timing.air_ns = air;
  if (fresh) {
    timing.content_ns = target.content_ns;
    timing.paint_ns = target.paint_ns;
    timing.ready_ns = target.ready_ns;
    timing.returned_ns = target.returned_ns;
  } else {
    // No new picture: this frame's memory still holds whatever it carried frames
    // ago, so the previous picture is copied in, with its times. Sending the stale
    // one would step the picture backwards.
    // Every slot of an output is the same kind of frame, so the same row length.
    // Into the slot that carried it, it is there already: only its times are taken.
    if (last_ != nullptr) {
      if (last_ != &slot) std::memcpy(slot.bytes(), last_->bytes(), static_cast<size_t>(slot.rowBytes()) * height_);
      timing.content_ns = last_->timing.content_ns;
      timing.paint_ns = last_->timing.paint_ns;
      timing.ready_ns = last_->timing.ready_ns;
      timing.returned_ns = last_->timing.returned_ns;
    }
  }
  timing.copied_ns = started_ ? card_->now() : 0;
  {
    // Recorded before the card has it: a driver may report the frame complete
    // before ScheduleVideoFrame returns, and the completion must find this slot's
    // own times, not the last frame's.
    std::lock_guard<std::mutex> lock(state_);
    slot.busy = true;
    slot.timing = timing;
    slot.scheduledIndex = index;
  }
  if (!card_->schedule(slot.sent(), at, frameDuration_, timeScale_)) {
    {
      std::lock_guard<std::mutex> lock(state_);
      slot.scheduledIndex = -1;
    }
    if (!started_ && !cardFrames_) {
      // Refused before playback began, in the helper's own frames: the driver
      // may not take application memory. Not a loss; the open is made again with
      // the card's frames.
      helperFramesRefused_ = true;
    } else {
      lose("the card refused a frame");
    }
    return false;
  }
  const uint64_t scheduledNs = started_ ? card_->now() : 0;
  if (!fresh) repeated_++;
  scheduled_++;
  skipping_ = false;
  std::lock_guard<std::mutex> lock(state_);
  // Unless the card has already finished with it, and kept its times without this.
  if (slot.scheduledIndex == index) slot.timing.scheduled_ns = scheduledNs;
  last_ = &slot;
  return true;
}

void Output::clockLoop() {
  // A real-time thread: the kernel does not coalesce its timers, so it wakes when
  // asked rather than a millisecond or more after (measured: 1.4 ms late at user-
  // interactive QoS, most of a fill lead). Its budget covers a fill, a copy and the
  // driver taking the frame (up to about 2 ms), and a begin.
  const double frameNs = static_cast<double>(frameDuration_) * 1e9 / static_cast<double>(timeScale_);
  thread_time_constraint_policy_data_t policy;
  policy.period = static_cast<uint32_t>(hostTicksAt(static_cast<uint64_t>(frameNs)));
  policy.computation = static_cast<uint32_t>(hostTicksAt(2500000));
  policy.constraint = static_cast<uint32_t>(hostTicksAt(5000000));
  policy.preemptible = 1;
  if (thread_policy_set(pthread_mach_thread_np(pthread_self()), THREAD_TIME_CONSTRAINT_POLICY,
                        reinterpret_cast<thread_policy_t>(&policy), THREAD_TIME_CONSTRAINT_POLICY_COUNT) != KERN_SUCCESS) {
    // Refused: run as well as a normal thread can, and say so (dl_counters).
    notRealtime_ = true;
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
  }
  while (!closing_ && !lost_) {
    uint64_t at = 0;
    const Event event = nextEvent(&at);
    const uint64_t now = card_->now();
    if (event != Event::none && at <= now) {
      run(event, now);
      continue;
    }
    // The card cannot say where its clock is: ask again in a millisecond.
    if (event == Event::none) {
      clockUnknown_ = true;
      std::unique_lock<std::mutex> lock(state_);
      if (closing_ || lost_) break;
      wake_.wait_for(lock, std::chrono::milliseconds(1));
      continue;
    }
    // Not due yet. A timed wait on a condition variable wakes 2 to 3 ms late on
    // macOS (the kernel coalesces timers), which is most of a fill lead, so the
    // last stretch is slept with mach_wait_until, which wakes within tens of
    // microseconds. That stretch cannot be cut short by close(), so it is kept short.
    const uint64_t wait = at - now;
    if (wait > kPreciseNs) {
      std::unique_lock<std::mutex> lock(state_);
      if (closing_ || lost_) break;
      wake_.wait_for(lock, std::chrono::nanoseconds(wait - kPreciseNs));
      continue;
    }
    mach_wait_until(hostTicksAt(at));
  }
}

void Output::runUntil(uint64_t until) {
  for (;;) {
    uint64_t at = 0;
    const Event event = nextEvent(&at);
    if (event == Event::none || at >= until || closing_ || lost_) return;
    run(event, at);
  }
}

Output::Slot *Output::slotFor(IDeckLinkVideoFrame *frame) {
  for (Slot &slot : slots_) {
    if (slot.sent() == frame) return &slot;
  }
  return nullptr;
}

void Output::completed(IDeckLinkVideoFrame *frame, Completion result, uint64_t completedNs) {
  if (closing_ || lost_) return;
  if (completedNs != 0) {
    const uint64_t now = card_->now();
    const uint64_t off = completedNs > now ? completedNs - now : now - completedNs;
    if (off > kPlausibleCompletionNs) {
      if (!implausible_.exchange(true)) {
        implausibleOffsetNs_ = static_cast<int64_t>(completedNs) - static_cast<int64_t>(now);
      }
      completedNs = 0;
    }
  }
  std::lock_guard<std::mutex> lock(state_);
  Slot *mine = slotFor(frame);
  if (mine == nullptr) return;
  if (result == Completion::flushed) {
    // Playback is stopping; nothing is scheduled again.
    mine->busy = false;
    mine->scheduledIndex = -1;
    return;
  }
  if (result == Completion::late || result == Completion::dropped) {
    dropped_++;
    // Three in a row may be the card's clock as kept being wrong, sending every
    // frame late: read it from the driver again.
    if (++lateRun_ >= 3) {
      lateRun_ = 0;
      card_->clockSuspect();
    }
  } else {
    lateRun_ = 0;
  }
  dl_frame_timing t = mine->timing;
  t.result = result == Completion::late ? 1 : result == Completion::dropped ? 2 : 0;
  t.completed_ns = completedNs;
  keep(t);
  mine->busy = false;
  // A frame shown on time, with the next slot ours too, finished exactly as that
  // slot began: the card's clock, read without asking the driver. After a skipped
  // slot it was held on longer, so it says nothing about the next.
  if (result == Completion::completed && completedNs > 0) {
    const int64_t next = mine->scheduledIndex + 1;
    for (const Slot &slot : slots_) {
      if (slot.scheduledIndex == next) {
        card_->slotBegan(next * frameDuration_, timeScale_, completedNs);
        break;
      }
    }
  }
  mine->scheduledIndex = -1;
}

void Output::keep(const dl_frame_timing &timing) {
  timings_.push_back(timing);
  while (timings_.size() > DL_TIMINGS_KEPT) timings_.pop_front();
}

int32_t Output::takeTimings(dl_frame_timing *out, int32_t capacity) {
  std::lock_guard<std::mutex> lock(state_);
  int32_t n = 0;
  while (n < capacity && !timings_.empty()) {
    out[n++] = timings_.front();
    timings_.pop_front();
  }
  return n;
}

void Output::lose(const char *reason) {
  if (lost_.exchange(true)) return;
  wake_.notify_all();
  if (!closing_ && callbacks_.lost != nullptr) callbacks_.lost(callbacks_.ctx, reason);
}

void Output::close() {
  {
    std::lock_guard<std::mutex> lock(state_);
    closing_ = true;
  }
  wake_.notify_all();
  if (clock_.joinable()) clock_.join();
  // No completion reaches this output once the card has stopped: a DeckLink card
  // clears its sink's output under the sink's own lock, and a software clock joins
  // its thread.
  card_->stop();
  std::lock_guard<std::mutex> work(work_);
}

void Output::counters(dl_counters *out) const {
  out->scheduled = scheduled_;
  out->repeated = repeated_;
  out->dropped = dropped_;
  out->resyncs = resyncs_;
  out->skipped = skipped_;
  out->lost = lost_;
  out->clock_not_realtime = notRealtime_;
  out->clock_unknown = clockUnknown_;
  out->completion_implausible = implausible_;
  out->implausible_offset_us = implausibleOffsetNs_ / 1000;
}

}  // namespace dlshim
