#include "output.hpp"

#include <cstdio>
#include <cstring>
#include <mach/mach.h>

namespace dlshim {

namespace {
bool sameIID(REFIID a, CFUUIDBytes b) { return std::memcmp(&a, &b, sizeof(CFUUIDBytes)) == 0; }
}  // namespace

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
  // vm_allocate gives page-aligned, zeroed memory, which a Metal buffer can wrap
  // without a copy (makeBuffer(bytesNoCopy:) wants both the start and the length
  // page-aligned).
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

void PoolFrame::fillBlack() {
  for (int32_t y = 0; y < height_; y++) {
    uint8_t *row = bytes_ + static_cast<size_t>(y) * rowBytes_;
    for (int32_t x = 0; x < rowBytes_; x += 4) {
      row[x] = 128;
      row[x + 1] = 16;
      row[x + 2] = 128;
      row[x + 3] = 16;
    }
  }
}

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

// MARK: Output

Output::Output(Card *card, int32_t width, int32_t height, int64_t frameDuration, int64_t timeScale,
               const dl_callbacks &callbacks)
    : card_(card),
      width_(width),
      height_(height),
      frameDuration_(frameDuration),
      timeScale_(timeScale),
      callbacks_(callbacks) {
  if (callbacks_.depth == 0) callbacks_.depth = 3;
  card_->attach(this);
}

Output::~Output() {
  for (PoolFrame *frame : frames_) frame->Release();
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
  if (callbacks_.depth < 2) {
    why = "an output needs at least two frames in flight";
    return false;
  }
  for (int32_t slot = 0; slot < callbacks_.depth; slot++) {
    auto *frame = new PoolFrame(width_, height_, slot);
    if (!frame->valid()) {
      frame->Release();
      why = "could not allocate a frame";
      return false;
    }
    frames_.push_back(frame);
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (PoolFrame *frame : frames_) {
      fillAndSchedule(frame);
      if (lost_) {
        why = "the card refused the pre-roll";
        return false;
      }
    }
  }
  if (!card_->start(0, timeScale_)) {
    why = "the card would not start playback";
    return false;
  }
  return true;
}

PoolFrame *Output::poolFrame(IDeckLinkVideoFrame *frame) const {
  for (PoolFrame *mine : frames_) {
    if (static_cast<IDeckLinkVideoFrame *>(mine) == frame) return mine;
  }
  return nullptr;
}

void Output::completed(IDeckLinkVideoFrame *frame, Completion result) {
  if (closing_ || lost_) return;
  std::lock_guard<std::mutex> lock(mutex_);
  if (closing_ || lost_) return;
  PoolFrame *mine = poolFrame(frame);
  if (mine == nullptr) return;

  switch (result) {
    case Completion::late:
    case Completion::dropped:
      dropped_++;
      break;
    case Completion::flushed:
      // Playback is stopping; nothing is scheduled again.
      return;
    case Completion::completed:
      break;
  }

  // The next frame has to go out after the one on air now. If it would not (the
  // host was held up and the card moved on), jump to just ahead of the card, rather
  // than going on scheduling frames in the past: those are shown late, which is
  // delay that never goes away, or dropped, which holds the picture until the
  // schedule has caught up.
  int64_t now = 0;
  if (card_->streamTime(timeScale_, &now)) {
    const int64_t onAir = floorDiv(now, frameDuration_);
    if (nextIndex_ <= onAir) {
      nextIndex_ = onAir + kResyncLead;
      resyncs_++;
    }
  }
  fillAndSchedule(mine);
}

void Output::fillAndSchedule(PoolFrame *frame) {
  const int64_t index = nextIndex_;
  const int64_t at = index * frameDuration_;
  const dl_frame_target target{frame->bytes(), frame->length(), frame->rowBytes(), width_, height_, frame->slot()};
  const bool fresh = callbacks_.fill != nullptr && callbacks_.fill(callbacks_.ctx, index, at, &target);
  if (!fresh) {
    // No new picture: this frame's memory still holds whatever it carried
    // `depth` frames ago, so the previous picture is copied in. Sending the stale
    // one would step the picture backwards.
    if (last_ != nullptr && last_ != frame) {
      std::memcpy(frame->bytes(), last_->bytes(), static_cast<size_t>(frame->rowBytes()) * height_);
    }
    repeated_++;
  }
  last_ = frame;
  if (!card_->schedule(frame, at, frameDuration_, timeScale_)) {
    lose("the card refused a frame");
    return;
  }
  scheduled_++;
  nextIndex_ = index + 1;
}

void Output::lose(const char *reason) {
  if (lost_.exchange(true)) return;
  if (!closing_ && callbacks_.lost != nullptr) callbacks_.lost(callbacks_.ctx, reason);
}

void Output::close() {
  closing_ = true;
  card_->stop();
  // A completion that was already running when closing_ was set finishes before
  // this returns.
  std::lock_guard<std::mutex> lock(mutex_);
}

void Output::counters(dl_counters *out) const {
  out->scheduled = scheduled_;
  out->repeated = repeated_;
  out->dropped = dropped_;
  out->resyncs = resyncs_;
  out->lost = lost_;
}

}  // namespace dlshim
