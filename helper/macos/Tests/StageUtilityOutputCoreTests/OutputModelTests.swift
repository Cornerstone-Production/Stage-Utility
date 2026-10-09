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
