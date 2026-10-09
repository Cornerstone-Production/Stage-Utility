// A small C API over Blackmagic's DeckLink SDK, for Swift.
//
// Everything that names the SDK's C++ interfaces is in decklink_shim.cpp; this
// header is plain C so Swift can import it. The SDK headers are vendored in
// Vendor/DeckLink, and the driver behind them is the user's Desktop Video install,
// loaded at run time. Without it every call here answers "not installed", "no
// ports" or "could not open"; none of them crashes.
//
// An output schedules frames on the card's clock. Each time the card finishes with
// a frame it asks the frame source (`dl_fill_fn`) for the picture of the frame that
// frame's memory will carry next, and schedules it. The same scheduler runs over a
// software clock (`dl_fake_output_open`) so it can be tested without a card.

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
/// line, page-aligned and `length` (a whole number of pages) long, so a Metal
/// buffer can be made over it without a copy. `slot` names which of the output's
/// frames it is, and stays the same memory for the life of the output.
typedef struct {
  void *bytes;
  size_t length;
  int32_t row_bytes;
  int32_t width;
  int32_t height;
  int32_t slot;
} dl_frame_target;

/// Write the picture for frame `frame_index` (shown at `stream_time`, in the mode's
/// time scale) into `target`, and return true. Return false, having written
/// nothing, when there is no new picture: the output then sends the previous
/// picture again and counts a repeat.
///
/// Called on the card's thread, while the card waits; return within a frame. Never
/// close the output from inside it.
typedef bool (*dl_fill_fn)(void *ctx, int64_t frame_index, int64_t stream_time, const dl_frame_target *target);

/// The output stopped and will not schedule again: the device was removed, the
/// driver refused a frame, or playback stopped on its own. Called once, on whatever
/// thread noticed. Close the output (not from inside this call) and open it again
/// when the port returns.
typedef void (*dl_lost_fn)(void *ctx, const char *reason);

typedef struct {
  dl_fill_fn fill;
  dl_lost_fn lost;
  void *ctx;
  /// Frames in flight, all of them scheduled before playback starts (the
  /// pre-roll). 0 means 3; at least 2.
  int32_t depth;
} dl_callbacks;

typedef struct dl_output dl_output;

/// Open `port` in `display_mode`, 8-bit YUV, with scheduled playback: `depth`
/// frames are filled and scheduled, then playback starts. NULL on failure, with the
/// reason in `why`.
dl_output *dl_output_open(const dl_port_id *port, uint32_t display_mode, const dl_callbacks *callbacks, char *why,
                          size_t why_len);

/// The same scheduler over a software clock, for tests and for running without a
/// card. With `timer` the clock ticks by itself every frame on its own thread;
/// without it, only `dl_fake_tick` moves it.
dl_output *dl_fake_output_open(int32_t width, int32_t height, int64_t frame_duration, int64_t time_scale, bool timer,
                               const dl_callbacks *callbacks, char *why, size_t why_len);

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
  /// Times the schedule had fallen behind the card and was moved forward.
  uint64_t resyncs;
  bool lost;
} dl_counters;

void dl_output_counters(const dl_output *output, dl_counters *out);

// MARK: Device changes

/// Called on the driver's thread when a DeckLink device arrives or goes. An open
/// output on a device that goes is also reported lost through its own callback.
typedef void (*dl_devices_changed_fn)(void *ctx);

/// Start watching for devices, once; a second call replaces the listener. False
/// when there is no driver to watch.
bool dl_watch_devices(dl_devices_changed_fn changed, void *ctx);

// MARK: The software clock's controls (fake outputs only; ignored on a real one)

/// Advance the clock `frames` frames, delivering each frame's completion as a card
/// would.
void dl_fake_tick(dl_output *output, int32_t frames);
/// Hold completions back as a busy host would: the clock moves, the callbacks do
/// not run. Releasing delivers everything held, in order.
void dl_fake_hold_completions(dl_output *output, bool hold);
/// Report the next `frames` completions as displayed late, as a card under load
/// does, although the software clock showed them on time.
void dl_fake_report_late(dl_output *output, int32_t frames);
/// As if the device were unplugged.
void dl_fake_unplug(dl_output *output);
/// What went out, one entry per frame of the clock: the first eight bytes of the
/// frame on air, read as a little-endian int64 (a test source writes its picture
/// number there). A slot with no frame of ours repeats the card's last picture, as
/// a card does. Returns how many entries there are; copies up to `capacity`.
int32_t dl_fake_shown(const dl_output *output, int64_t *pictures, int32_t capacity);

#ifdef __cplusplus
}
#endif

#endif
