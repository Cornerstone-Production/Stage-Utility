// The scheduler every output runs, card or software clock: which frame goes out
// when, what a frame carries when the source has no new picture, and what is
// counted. Nothing in here talks to a driver; a `Card` does.

#ifndef DECKLINK_SHIM_OUTPUT_HPP
#define DECKLINK_SHIM_OUTPUT_HPP

#include "DeckLinkAPI.h"
#include "decklink_shim.h"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
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

/// 8-bit UYVY black, Y 16 and Cb, Cr 128, over `width` pixels of each row.
void fillBlack(uint8_t *bytes, int32_t rowBytes, int32_t width, int32_t height);

enum class Completion { completed, late, dropped, flushed };

class Output;

/// A frame the card made itself (IDeckLinkOutput::CreateVideoFrame), retained,
/// and where its bytes are. Used when the card will not take the helper's own.
struct CardFrame {
  IDeckLinkVideoFrame *frame = nullptr;
  uint8_t *bytes = nullptr;
  int32_t rowBytes = 0;
};

/// mach_absolute_time in nanoseconds: the host clock every time here is on.
uint64_t hostNowNs();

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
  /// When stream time `streamTime` (in `timeScale`) is, or was, on air, on this
  /// card's host clock (`now`). False before playback has started.
  virtual bool hostTimeOf(int64_t streamTime, int64_t timeScale, uint64_t *hostNs) = 0;
  /// The card finished the frame before slot `streamTime` (in `timeScale`) at
  /// `hostNs`: when that slot began, for a card that keeps its clock from its
  /// completions.
  virtual void slotBegan(int64_t streamTime, int64_t timeScale, uint64_t hostNs) {}
  /// Frames keep going out late: forget the clock as kept, and read it again.
  virtual void clockSuspect() {}
  /// The host clock as this card keeps it: the real one, or a test's own.
  virtual uint64_t now() { return hostNowNs(); }
  /// True for a clock only tests move: the card runs the output's begins and fills
  /// itself as its time passes (Output::runUntil), and the output starts no thread.
  virtual bool drivesClock() const { return false; }
  /// The least time before its slot a frame must be scheduled to go out on time.
  virtual uint64_t minLeadNs() const { return 0; }
  virtual bool start(int64_t at, int64_t timeScale) = 0;
  /// Stop playback. No completion is delivered after this returns.
  virtual void stop() = 0;
  virtual bool isFake() const { return false; }

 protected:
  Output *output_ = nullptr;
};

class Output {
 public:
  /// Frames filled and scheduled before playback starts, with whatever picture
  /// there is: the card needs one (BMDDeckLinkMinimumPrerollFrames on an 8K Pro)
  /// and the second covers the slot after it, before the clock thread runs.
  static constexpr int32_t kPreroll = 2;

  /// With `cardFrames` the card's own frames carry the pictures; without, frames of
  /// the helper's own memory do. The source writes into whichever it is.
  Output(Card *card, int32_t width, int32_t height, int64_t frameDuration, int64_t timeScale,
         const dl_callbacks &callbacks, bool cardFrames);
  ~Output();

  /// Make the frames, fill and schedule the pre-roll, start playback and the clock.
  bool start(std::string &why);

  /// The card has finished with `frame`, at `completedNs` on the host clock (0 if
  /// it cannot say). Counts a late or dropped result and frees the frame.
  void completed(IDeckLinkVideoFrame *frame, Completion result, uint64_t completedNs);

  /// The port is gone or refused us. Stops scheduling and tells the owner, once.
  void lose(const char *reason);

  /// Stop the clock and the card, and wait out any completion still running.
  void close();

  /// For a card that drives the clock (Card::drivesClock): run, in time order,
  /// every begin and fill due before `until` on the card's clock.
  void runUntil(uint64_t until);

  void counters(dl_counters *out) const;
  int32_t takeTimings(dl_frame_timing *out, int32_t capacity);
  Card *card() const { return card_; }
  bool cardFrames() const { return cardFrames_; }
  /// The open failed because the card refused the helper's own frames during the
  /// pre-roll: the case for opening again with card frames.
  bool helperFramesRefused() const { return helperFramesRefused_; }
  /// The open failed because the card would not make frames of its own: the case
  /// for opening again with the helper's.
  bool cardFramesUnavailable() const { return cardFramesUnavailable_; }

 private:
  /// One frame of memory: the card's own (`card`) or the helper's (`staging`),
  /// whichever the output sends in; the source writes the picture straight into
  /// it. `busy` from the fill that takes it until the card gives it back.
  struct Slot {
    PoolFrame *staging = nullptr;
    CardFrame card;
    uint8_t *bytes() const { return card.frame != nullptr ? card.bytes : staging->bytes(); }
    int32_t rowBytes() const { return card.frame != nullptr ? card.rowBytes : staging->rowBytes(); }
    bool busy = false;
    /// The frame index it is scheduled for, -1 when it is not with the card.
    int64_t scheduledIndex = -1;
    dl_frame_timing timing{};
    IDeckLinkVideoFrame *sent() const {
      return card.frame != nullptr ? card.frame : static_cast<IDeckLinkVideoFrame *>(staging);
    }
  };

  enum class Event { none, begin, fill };

  /// The next begin or fill and when it is due, on the card's clock. `none` when
  /// the card cannot say where its clock is.
  Event nextEvent(uint64_t *at);
  /// Run the event `nextEvent` named, at `now`.
  void run(Event event, uint64_t now);
  void begin(uint64_t now);
  /// Fill and schedule slot `nextFill_`, or skip it when it cannot go out on time.
  void fill(uint64_t now);
  /// Fill `slot` for frame `index` and hand it to the card. False when the card
  /// refused it.
  bool fillAndSchedule(Slot &slot, int64_t index, uint64_t now, uint64_t air);
  /// `why`: 0 too late to make it, 1 no frame free (dl_frame_timing.result).
  void skip(int64_t index, uint64_t air, int32_t why);
  bool airOf(int64_t index, uint64_t *at);
  void clockLoop();
  Slot *slotFor(IDeckLinkVideoFrame *frame);
  void keep(const dl_frame_timing &timing);

  Card *card_;
  int32_t width_;
  int32_t height_;
  int64_t frameDuration_;
  int64_t timeScale_;
  uint64_t headStartNs_;
  uint64_t fillLeadNs_;
  dl_callbacks callbacks_;
  std::vector<Slot> slots_;
  bool attached_ = false;
  const bool cardFrames_;
  bool started_ = false;
  bool helperFramesRefused_ = false;
  bool cardFramesUnavailable_ = false;

  // The clock's own: touched only by the clock thread (or runUntil).
  int64_t nextBegin_ = kPreroll;
  int64_t nextFill_ = kPreroll;
  /// The slot carrying the last picture sent: what a repeat copies, so never
  /// filled again until another has been sent.
  Slot *last_ = nullptr;
  /// The previous slot was skipped: a run of skips is one resync.
  bool skipping_ = false;

  /// Held for a fill, so close() can wait one out. Never taken by a completion.
  std::mutex work_;
  /// Slot ownership, the kept timings and the clock's wait. Never held across a
  /// call into the driver or the source.
  mutable std::mutex state_;
  std::condition_variable wake_;
  std::thread clock_;
  std::deque<dl_frame_timing> timings_;

  std::atomic<bool> closing_{false};
  std::atomic<bool> lost_{false};
  std::atomic<bool> notRealtime_{false};
  std::atomic<bool> clockUnknown_{false};
  /// Completions reported late or dropped in a row; touched under state_.
  int lateRun_ = 0;
  std::atomic<uint64_t> scheduled_{0};
  std::atomic<uint64_t> repeated_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<uint64_t> resyncs_{0};
  std::atomic<uint64_t> skipped_{0};
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
/// `why`, if it cannot), in the frames `callbacks.card_frames` asks for. If the
/// card will not have those (it refuses the helper's during the pre-roll, or will
/// not make its own), the open is made again, once, on a fresh card, in the other.
template <typename MakeCard>
dl_output *openOutput(MakeCard makeCard, const dl_callbacks &callbacks, std::string &why) {
  bool cardFrames = callbacks.card_frames;
  bool switched = false;
  for (;;) {
    Geometry g;
    Card *card = makeCard(why, g);
    if (card == nullptr) return nullptr;
    auto *output = new Output(card, g.width, g.height, g.frameDuration, g.timeScale, callbacks, cardFrames);
    if (output->start(why)) return new dl_output{card, output};
    const bool again =
        !switched && (cardFrames ? output->cardFramesUnavailable() : output->helperFramesRefused());
    output->close();
    delete output;
    delete card;
    if (!again) return nullptr;
    switched = true;
    cardFrames = !cardFrames;
  }
}

}  // namespace dlshim

#endif
