// The scheduler every output runs, card or software clock: which frame goes out
// when, what a frame carries when the source has no new picture, and what is
// counted. Nothing in here talks to a driver; a `Card` does.

#ifndef DECKLINK_SHIM_OUTPUT_HPP
#define DECKLINK_SHIM_OUTPUT_HPP

#include "DeckLinkAPI.h"
#include "decklink_shim.h"

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace dlshim {

/// One frame of an output: memory the helper owns, which the card reads. The SDK
/// lets an application hand over its own IDeckLinkVideoFrame; owning the memory is
/// what lets Metal write the picture straight into it.
class PoolFrame final : public IDeckLinkVideoFrame {
 public:
  PoolFrame(int32_t width, int32_t height, int32_t slot);

  bool valid() const { return bytes_ != nullptr; }
  uint8_t *bytes() const { return bytes_; }
  size_t length() const { return length_; }
  int32_t rowBytes() const { return rowBytes_; }
  int32_t slot() const { return slot_; }
  /// 8-bit UYVY black: Y 16, Cb and Cr 128.
  void fillBlack();

  // IUnknown
  HRESULT QueryInterface(REFIID iid, LPVOID *ppv) override;
  ULONG AddRef() override;
  ULONG Release() override;

  // IDeckLinkVideoFrame
  long GetWidth() override { return width_; }
  long GetHeight() override { return height_; }
  long GetRowBytes() override { return rowBytes_; }
  BMDPixelFormat GetPixelFormat() override { return bmdFormat8BitYUV; }
  BMDFrameFlags GetFlags() override { return bmdFrameFlagDefault; }
  HRESULT GetBytes(void **buffer) override;
  HRESULT GetTimecode(BMDTimecodeFormat format, IDeckLinkTimecode **timecode) override;
  HRESULT GetAncillaryData(IDeckLinkVideoFrameAncillary **ancillary) override;

 private:
  ~PoolFrame() override;
  std::atomic<ULONG> refs_{1};
  int32_t width_;
  int32_t height_;
  int32_t rowBytes_;
  int32_t slot_;
  uint8_t *bytes_ = nullptr;
  size_t length_ = 0;
};

enum class Completion { completed, late, dropped, flushed };

class Output;

/// A frame the card made itself (IDeckLinkOutput::CreateVideoFrame), retained,
/// and where its bytes are. Used when the card will not take the helper's own.
struct CardFrame {
  IDeckLinkVideoFrame *frame = nullptr;
  uint8_t *bytes = nullptr;
  int32_t rowBytes = 0;
};

/// The thing that plays frames out on its own clock: a DeckLink port, or the
/// software clock that stands in for one.
class Card {
 public:
  virtual ~Card() = default;
  /// Called once, before anything is scheduled. False when the card will not
  /// report completions, which would leave it showing the pre-roll for good.
  virtual bool attach(Output *output) {
    output_ = output;
    return true;
  }
  virtual bool schedule(IDeckLinkVideoFrame *frame, int64_t displayTime, int64_t duration, int64_t timeScale) = 0;
  /// A frame of the card's own memory, 8-bit YUV, retained; empty if it cannot.
  virtual CardFrame createFrame(int32_t width, int32_t height, int32_t rowBytes) = 0;
  /// The card's playback position, in the mode's time scale.
  virtual bool streamTime(int64_t timeScale, int64_t *now) = 0;
  virtual bool start(int64_t at, int64_t timeScale) = 0;
  /// Stop playback. No completion is delivered after this returns.
  virtual void stop() = 0;
  virtual bool isFake() const { return false; }

 protected:
  Output *output_ = nullptr;
};

class Output {
 public:
  /// How far ahead of the frame on air a schedule that fell behind is moved.
  /// Two frames: one would be due before this callback could hand it over.
  static constexpr int64_t kResyncLead = 2;

  /// With `cardFrames` the card's own frames carry the pictures, each copied in
  /// from the helper's frame the source wrote; without, the helper's frames go to
  /// the card as they are.
  Output(Card *card, int32_t width, int32_t height, int64_t frameDuration, int64_t timeScale,
         const dl_callbacks &callbacks, bool cardFrames);
  ~Output();

  /// Make the frames, fill and schedule all of them, and start playback.
  bool start(std::string &why);

  /// The card has finished with `frame`. Counts a late or dropped result, moves
  /// the schedule forward if it has fallen behind the card, and schedules the
  /// frame again with the next picture.
  void completed(IDeckLinkVideoFrame *frame, Completion result);

  /// The port is gone or refused us. Stops scheduling and tells the owner, once.
  void lose(const char *reason);

  /// Stop the card and wait out any completion still running.
  void close();

  void counters(dl_counters *out) const;
  Card *card() const { return card_; }
  bool cardFrames() const { return cardFrames_; }
  /// The open failed because the card refused the helper's own frames during the
  /// pre-roll: the case for opening again with card frames.
  bool helperFramesRefused() const { return helperFramesRefused_; }

 private:
  /// One frame in flight. `staging` is the helper's memory the source writes into;
  /// `card` is the card's own frame when there is one, and is what is scheduled.
  struct Slot {
    PoolFrame *staging = nullptr;
    CardFrame card;
    IDeckLinkVideoFrame *sent() const {
      return card.frame != nullptr ? card.frame : static_cast<IDeckLinkVideoFrame *>(staging);
    }
  };

  void fillAndSchedule(Slot &slot);
  Slot *slotFor(IDeckLinkVideoFrame *frame);

  Card *card_;
  int32_t width_;
  int32_t height_;
  int64_t frameDuration_;
  int64_t timeScale_;
  dl_callbacks callbacks_;
  std::vector<Slot> slots_;
  bool attached_ = false;
  const bool cardFrames_;
  bool started_ = false;
  bool helperFramesRefused_ = false;

  /// Held for the whole of a completion, so close() can wait one out.
  std::mutex mutex_;
  /// The frame index the next scheduled frame is shown at; its display time is
  /// this times the frame duration. Playback starts at 0.
  int64_t nextIndex_ = 0;
  /// The staging frame most recently scheduled: the picture to send again on a
  /// repeat.
  PoolFrame *last_ = nullptr;

  std::atomic<bool> closing_{false};
  std::atomic<bool> lost_{false};
  std::atomic<uint64_t> scheduled_{0};
  std::atomic<uint64_t> repeated_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<uint64_t> resyncs_{0};
};

/// Floor division for stream times, which are never negative in practice but
/// must not round toward zero if they were.
inline int64_t floorDiv(int64_t a, int64_t b) {
  int64_t q = a / b;
  return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q;
}

void copyReason(const std::string &reason, char *why, size_t whyLen);

}  // namespace dlshim

/// The opaque handle the C API hands out.
struct dl_output {
  dlshim::Card *card;
  dlshim::Output *output;
};

namespace dlshim {

/// A mode's frame size and timing.
struct Geometry {
  int32_t width = 0;
  int32_t height = 0;
  int64_t frameDuration = 0;
  int64_t timeScale = 0;
};

/// Open an output on the card `makeCard(why, geometry)` returns (nullptr, with
/// `why`, if it cannot). If that card refuses the helper's own frames during the
/// pre-roll, the open is made again, on a fresh card, with card frames.
template <typename MakeCard>
dl_output *openOutput(MakeCard makeCard, const dl_callbacks &callbacks, std::string &why) {
  bool cardFrames = callbacks.card_frames;
  for (;;) {
    Geometry g;
    Card *card = makeCard(why, g);
    if (card == nullptr) return nullptr;
    auto *output = new Output(card, g.width, g.height, g.frameDuration, g.timeScale, callbacks, cardFrames);
    if (output->start(why)) return new dl_output{card, output};
    const bool again = !cardFrames && output->helperFramesRefused();
    output->close();
    delete output;
    delete card;
    if (!again) return nullptr;
    cardFrames = true;
  }
}

}  // namespace dlshim

#endif
