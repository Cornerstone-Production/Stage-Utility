import Testing
@testable import StageUtilityOutputCore

@Suite struct OutputModelTests {
  @Test func mainDisplayIsOffByDefault() {
    #expect(defaultEnabled(kind: .display, isMain: true) == false)
  }

  @Test func otherDisplaysAreOnByDefault() {
    #expect(defaultEnabled(kind: .display, isMain: false) == true)
  }

  /// A DeckLink port is never the Mac's desktop, whatever flag it carries.
  @Test func decklinkPortsAreOnByDefault() {
    #expect(defaultEnabled(kind: .decklink, isMain: false) == true)
    #expect(defaultEnabled(kind: .decklink, isMain: true) == true)
  }

  @Test func displayNameUsesTheConnectorWhenKnown() {
    let n = OutputNaming.display(connector: "Built-in", index: 1, localizedName: "Studio Display")
    #expect(n.port == "Built-in")
    #expect(n.name == "Built-in · Studio Display")
  }

  @Test func displayNameFallsBackToDisplayN() {
    let n = OutputNaming.display(connector: nil, index: 2, localizedName: "LG 27UL")
    #expect(n.port == "Display 2")
    #expect(n.name == "Display 2 · LG 27UL")
    #expect(OutputNaming.display(connector: "", index: 3, localizedName: "").name == "Display 3")
  }
}

@Suite struct VirtualCardsTests {
  @Test func noneWithoutTheFlag() {
    #expect(VirtualCards.outputs(count: 0).isEmpty)
  }

  /// A virtual output's key is its device id's suffix, so it must not change between
  /// runs or its screen is orphaned. Same count, same keys, in order.
  @Test func theyAreNumberedCardOutputsWithStableKeys() {
    let outputs = VirtualCards.outputs(count: 4)
    #expect(outputs.map(\.key) == ["virtual-sdi-1", "virtual-sdi-2", "virtual-sdi-3", "virtual-sdi-4"])
    #expect(outputs.map(\.name) == ["SDI 1 (virtual)", "SDI 2 (virtual)", "SDI 3 (virtual)", "SDI 4 (virtual)"])
    #expect(outputs.allSatisfy { $0.kind == .decklink && $0.modes == ["1080p59.94"] && !$0.isMain })
    #expect(VirtualCards.outputs(count: 4) == outputs)
    #expect(Array(VirtualCards.outputs(count: 6).prefix(4)) == outputs)
  }

  /// They start on, like every output but the main display, so `--virtual-sdi 4`
  /// alone shows four outputs on the server.
  @Test func theyStartOn() {
    #expect(VirtualCards.outputs(count: 2).allSatisfy { defaultEnabled(kind: $0.kind, isMain: $0.isMain) })
  }

  /// The key goes into a URL path and a file name, like a display's.
  @Test func theKeysAreSafeInAPathAndAFileName() {
    for d in VirtualCards.outputs(count: VirtualCards.maxCount) {
      #expect(DeviceIdentity.outputKey(displayUUID: d.key) == d.key)
    }
  }
}
