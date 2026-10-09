import Foundation
import Metal
import Testing

/// Whether this Mac has a Metal device for the tests that convert on the GPU. A CI
/// runner may have none (`MTLCreateSystemDefaultDevice()` returns nil there): those
/// suites are skipped with this reason rather than failing. Setting
/// STAGE_UTILITY_TEST_NO_METAL=1 forces the skip, to check it on a Mac that has one.
enum GPU {
  static let available: Bool =
    ProcessInfo.processInfo.environment["STAGE_UTILITY_TEST_NO_METAL"] == nil
    && MTLCreateSystemDefaultDevice() != nil

  static let skipped: Comment =
    "no Metal device here (MTLCreateSystemDefaultDevice() returned nil, as on a CI runner without a GPU): the GPU conversion is not tested"
}
