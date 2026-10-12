// A small C API over Blackmagic's DeckLink SDK, for Swift.
//
// Everything that names the SDK's C++ interfaces is in decklink_shim.cpp; this
// header is plain C so Swift can import it. The SDK headers are vendored in
// Vendor/DeckLink, and the driver behind them is the user's Desktop Video install,
// loaded at run time. Without it every call here answers "not installed", "no
// ports" or "could not open"; none of them crashes.
//
// An output schedules frames on the card's clock, one slot at a time, at fixed
// times before each slot goes to air: it asks the page for the slot's picture
// (`dl_begin_fn`) a head start ahead, and fills and schedules the slot
// (`dl_fill_fn`) a fill lead ahead, with whatever picture is newest by then. The
// same scheduler runs over a software clock (`dl_fake_output_open`) so it can be
// tested without a card.

#ifndef DECKLINK_SHIM_H
#define DECKLINK_SHIM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// MARK: The driver

typedef enum {
  /// No /Library/Frameworks/DeckLinkAPI.framework: Desktop Video is not installed.
  DL_DRIVER_NOT_INSTALLED = 0,
  DL_DRIVER_INSTALLED = 1,
  /// Installed, but older than the SDK these headers are (12.0), so it does not
  /// offer the interfaces the helper asks for.
  DL_DRIVER_TOO_OLD = 2,
  /// The framework is on disk but its API could not be loaded from it.
  DL_DRIVER_UNUSABLE = 3,
} dl_driver_state;

typedef struct {
  dl_driver_state state;
  /// BMDDeckLinkAPIVersion, 0xMMmmpp00 ("12.4.1" is 0x0c040100). 0 when unknown.
  int64_t version;
  /// The driver's own wording of its version, "" when unknown.
  char version_string[32];
} dl_driver_info;

void dl_driver_get(dl_driver_info *out);

// MARK: Ports and their modes

typedef enum {
  DL_FIELD_UNKNOWN = 0,
  DL_FIELD_PROGRESSIVE = 1,
  DL_FIELD_UPPER_FIRST = 2,
  DL_FIELD_LOWER_FIRST = 3,
  DL_FIELD_PSF = 4,
} dl_field;

typedef struct {
  /// BMDDisplayMode, a four-character code ('Hp59' is 1080p59.94).
  uint32_t display_mode;
  /// As the driver names it, UTF-8.
  char name[64];
  int32_t width;
  int32_t height;
  /// A frame lasts frame_duration / time_scale seconds (1001 / 60000 for 59.94).
  /// For an interlaced mode this is the frame, two fields.
  int64_t frame_duration;
  int64_t time_scale;
  dl_field field;
  /// The port plays this mode in 8-bit YUV 4:2:2 (bmdFormat8BitYUV, UYVY), the
  /// only format the helper sends.
  bool yuv8;
} dl_mode;

/// Which port. A card's persistent id survives reboots and re-plugging; a card
/// with several connectors is several sub-devices. A card that reports no
/// persistent id is matched by its topological id (where it sits on the bus).
typedef struct {
  bool has_persistent_id;
  int64_t persistent_id;
  bool has_topological_id;
  int64_t topological_id;
  int64_t sub_device;
} dl_port_id;

typedef struct {
  dl_port_id id;
  char display_name[128];
  char model_name[128];
  int32_t mode_count;
} dl_port_info;

typedef struct dl_port_list dl_port_list;

/// The ports that can play out, with their modes. Never NULL: without a driver the
/// list is empty.
dl_port_list *dl_port_list_create(void);
int32_t dl_port_list_count(const dl_port_list *list);
bool dl_port_list_port(const dl_port_list *list, int32_t port, dl_port_info *out);
bool dl_port_list_mode(const dl_port_list *list, int32_t port, int32_t mode, dl_mode *out);
void dl_port_list_free(dl_port_list *list);

// MARK: An output

/// The memory of the frame about to be scheduled: 8-bit UYVY, `row_bytes` per
/// line (which may be longer than the picture's), `length` long. `slot` names which
/// of the output's frames it is, and stays the same memory for the life of the
/// output. The source copies its picture in.
typedef struct {
  void *bytes;
  size_t length;
  int32_t row_bytes;
  int32_t width;
  int32_t height;
  int32_t slot;
  /// Written by the source with a new picture: when the picture's content was
  /// drawn (the page's begin frame), when the page handed it over, when the page's
  /// own copy could be let go (the paint callback returned), and when it was ready
  /// to copy. Host time in nanoseconds (mach_absolute_time), 0 when unknown.
  uint64_t content_ns;
  uint64_t paint_ns;
  uint64_t ready_ns;
  uint64_t returned_ns;
} dl_frame_target;

/// Write the newest picture for frame `frame_index` (shown at `stream_time`, in the
/// mode's time scale) into `target`, and return true. Return false, having written
/// nothing, when there is no new picture: the output then sends the previous
/// picture again and counts a repeat.
///
/// Called on the output's clock thread `fill_lead_us` before the frame goes to air,
/// while the card waits: return well within that (a copy, not a render). The
/// pre-roll's two are called on the thread opening the output. Never close the
/// output from inside it.
typedef bool (*dl_fill_fn)(void *ctx, int64_t frame_index, int64_t stream_time, dl_frame_target *target);

/// Ask the page for the picture of frame `frame_index`: called on the output's
/// clock thread `head_start_us` before the frame goes to air. Return at once; the
/// picture arrives in its own time and the fill takes the newest there is.
typedef void (*dl_begin_fn)(void *ctx, int64_t frame_index, int64_t stream_time);

/// The output stopped and will not schedule again: the device was removed, the
/// driver refused a frame, or playback stopped on its own. Called once, on whatever
/// thread noticed. Close the output (not from inside this call) and open it again
/// when the port returns. It can also come during dl_output_open, for a first try
/// that the open then makes again in the other kind of frame: `ctx` is the same,
/// but there is no handle to close.
typedef void (*dl_lost_fn)(void *ctx, const char *reason);

typedef struct {
  dl_fill_fn fill;
  dl_lost_fn lost;
  void *ctx;
  /// Frames of memory: the frame on air, the one scheduled after it, and room to
  /// fill the next while a completion is still on its way. 0 means 3; at least 2.
  /// More frames do not add delay: when a frame goes out is set by the leads below.
  int32_t depth;
  /// Send in frames the card makes (CreateVideoFrame), which the helper asks for:
  /// the driver takes them without a stall (DECKLINK.md, "Helper frames and card
  /// frames"). Without it, frames of the helper's own memory. A card that will not
  /// have the kind asked for (will not make its own, or refuses the helper's
  /// during the pre-roll) gets the other (see dl_output_frames).
  bool card_frames;
  /// May be NULL: nothing is asked for, and the fill takes whatever is newest.
  dl_begin_fn begin;
  /// How long before a frame goes to air the page is asked for it. 0 means
  /// DL_DEFAULT_HEAD_START_US.
  int64_t head_start_us;
  /// How long before a frame goes to air it is filled and scheduled. 0 means
  /// DL_DEFAULT_FILL_LEAD_US.
  int64_t fill_lead_us;
} dl_callbacks;

/// The defaults, measured on a DeckLink 8K Pro (DECKLINK.md, "Latency"): a page
/// gets 20 ms from being asked to being filled less the 5 ms fill lead, and the
/// card gets the frame about 3.7 ms before its slot.
#define DL_DEFAULT_HEAD_START_US 20000
#define DL_DEFAULT_FILL_LEAD_US 5000
/// A fill that starts later than this before its slot is skipped, the card holding
/// its previous picture, rather than sent late: the copy and the driver taking the
/// frame (about 1.3 ms) and the card's own need (it shows a frame late when it has
/// it less than 2.3 to 2.8 ms before its slot) would not fit.
#define DL_CARD_MIN_LEAD_US 3500

/// Which frames carry an output's pictures.
typedef enum {
  /// The helper's own page-aligned memory, which the source writes straight into.
  DL_FRAMES_HELPER = 0,
  /// Frames the card made (IDeckLinkOutput::CreateVideoFrame). The source writes
  /// the picture straight into them.
  DL_FRAMES_CARD = 1,
} dl_frames;

typedef struct dl_output dl_output;

/// Open `port` in `display_mode`, 8-bit YUV, with scheduled playback: the first two
/// frames are filled and scheduled, then playback starts. NULL on failure, with the
/// reason in `why`.
dl_output *dl_output_open(const dl_port_id *port, uint32_t display_mode, const dl_callbacks *callbacks, char *why,
                          size_t why_len);

/// How a software clock behaves.
typedef struct {
  /// The clock ticks by itself every frame on its own thread, on the host's time.
  /// Without it only `dl_fake_tick` moves it, on time of its own.
  bool timer;
  /// It refuses any frame it did not make itself, as a driver that will not take
  /// application memory would.
  bool refuse_helper_frames;
  /// It will not make frames of its own.
  bool make_no_frames;
  /// It needs a frame this long before its slot (Card::minLeadNs); 0 for none.
  int64_t min_lead_us;
  /// The frames it makes are counted in dl_fake_card_frames_alive.
  bool count_frames;
  /// It cannot say where its playback is (Card::hostTimeOf fails), as a driver
  /// that will not answer GetScheduledStreamTime, nor when a frame finished (its
  /// completions carry no time, so none of them anchors the clock).
  bool clock_unknown;
} dl_fake_behaviour;

/// The same scheduler over a software clock, for tests and for running without a
/// card.
dl_output *dl_fake_output_open(int32_t width, int32_t height, int64_t frame_duration, int64_t time_scale,
                               const dl_fake_behaviour *behaviour, const dl_callbacks *callbacks, char *why,
                               size_t why_len);

/// How many times the output has asked a software clock where its playback is: once
/// when it starts, and again each time its clock as kept is suspect (ClockAnchor).
int64_t dl_fake_clock_reads(const dl_output *output);

/// Frames the software clocks that count them (`count_frames`) have made and not
/// yet freed, across the process.
int32_t dl_fake_card_frames_alive(void);

dl_frames dl_output_frames(const dl_output *output);

/// Stop playback and free the output. No callback runs after this returns.
void dl_output_close(dl_output *output);

typedef struct {
  /// Frames handed to the card.
  uint64_t scheduled;
  /// Of those, frames that carried the previous picture again because the source
  /// had none.
  uint64_t repeated;
  /// Frames the card reported late (bmdOutputFrameDisplayedLate) or dropped
  /// (bmdOutputFrameDropped).
  uint64_t dropped;
  /// Times the output found itself too late to fill a slot on time (the host was
  /// held up, or the card had not given a frame back) and skipped ahead.
  uint64_t resyncs;
  /// Slots skipped: no frame of ours was scheduled for them, so the card held its
  /// last picture. Not counted in `scheduled`.
  uint64_t skipped;
  bool lost;
  /// The clock thread asked to be real-time and was refused: its waits may then
  /// end a millisecond or more late. False before the thread has asked, and for a
  /// clock only tests move, which has no thread.
  bool clock_not_realtime;
  /// The card could not say where its playback is, so nothing could be timed.
  bool clock_unknown;
  /// A completion time came more than 20 ms from when it was reported: completion
  /// times that far off are not used (Output::completed). `implausible_offset_us`
  /// is how far the first one was, positive in the future.
  bool completion_implausible;
  int64_t implausible_offset_us;
} dl_counters;

void dl_output_counters(const dl_output *output, dl_counters *out);

/// What became of one slot, with the times of its picture on the way: host time in
/// nanoseconds (mach_absolute_time), 0 when unknown.
typedef struct {
  int64_t index;
  /// A new picture; false for a repeat of the one before (whose times it carries).
  bool fresh;
  /// Nothing of ours went out in this slot.
  bool skipped;
  /// The card's report: 0 completed, 1 displayed late, 2 dropped. For a skip, why:
  /// 0 too late to reach the card in time, 1 every frame was still with the card.
  int32_t result;
  /// The picture: when its content was drawn, when the page handed it over, when it
  /// was ready to copy (the source's stamps, dl_frame_target).
  uint64_t content_ns;
  uint64_t paint_ns;
  uint64_t ready_ns;
  /// When the paint callback that handed the picture over returned.
  uint64_t returned_ns;
  /// When the fill began (the fill lead before air), when the picture was in the
  /// frame, and when the card had taken it (ScheduleVideoFrame returned).
  uint64_t fill_ns;
  uint64_t copied_ns;
  uint64_t scheduled_ns;
  /// When the slot began going out of the card: its display time on the card's
  /// clock, mapped to the host's.
  uint64_t air_ns;
  /// When the card said it had finished with the frame: the end of its slot
  /// (GetFrameCompletionReferenceTimestamp, which is on the host clock); a software
  /// clock gives the time it ticked. 0 for a skip.
  uint64_t completed_ns;
} dl_frame_timing;

/// The slots finished since the last call, oldest first, up to `capacity`; returns
/// how many were copied. At most DL_TIMINGS_KEPT are kept between calls: older
/// ones are dropped.
int32_t dl_output_take_timings(dl_output *output, dl_frame_timing *out, int32_t capacity);
#define DL_TIMINGS_KEPT 1024

/// The host clock every time above is on: mach_absolute_time in nanoseconds.
uint64_t dl_host_now_ns(void);

// MARK: Device changes

/// Called on the driver's thread when a DeckLink device arrives or goes. An open
/// output on a device that goes is also reported lost through its own callback.
typedef void (*dl_devices_changed_fn)(void *ctx);

/// Start watching for devices, once; a second call replaces the listener. False
/// when there is no driver to watch.
bool dl_watch_devices(dl_devices_changed_fn changed, void *ctx);

// MARK: The software clock's controls (fake outputs only; ignored on a real one)

/// Advance the clock `frames` frames, running each begin and fill that falls due on
/// the way and delivering each frame's completion, as a card would. A clock that
/// only the tests move keeps time of its own: slot n begins at n frame durations.
void dl_fake_tick(dl_output *output, int32_t frames);
/// Hold completions back as a busy host would: the clock moves, the callbacks do
/// not run. Releasing delivers everything held, in order.
void dl_fake_hold_completions(dl_output *output, bool hold);
/// Report the next `frames` completions as displayed late, as a card under load
/// does, although the software clock showed them on time.
void dl_fake_report_late(dl_output *output, int32_t frames);
/// As if the device were unplugged.
void dl_fake_unplug(dl_output *output);
/// Have the clock's playback position, when the output asks for it, say a host time
/// `us` later than the truth, as a driver's answer can be off by its own latency.
void dl_fake_clock_read_error(dl_output *output, int64_t us);
/// Report the next `count` completions `us` later than the slot boundary they
/// happened at, as a frame held on longer would, or a timestamp on another clock.
void dl_fake_completion_offset(dl_output *output, int64_t us, int32_t count);
/// What went out, one entry per frame of the clock: the first eight bytes of the
/// frame on air, read as a little-endian int64 (a test source writes its picture
/// number at the start of every line), or -2 when the frame's last line does not
/// start the same way. A slot with no frame of ours repeats the card's last
/// picture, as a card does. Returns how many entries there are; copies up to `capacity`.
int32_t dl_fake_shown(const dl_output *output, int64_t *pictures, int32_t capacity);

#ifdef __cplusplus
}
#endif

#endif
