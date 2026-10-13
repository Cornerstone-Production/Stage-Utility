// senderLabel: a name as a message signs it, without a trailing role word.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { senderLabel } from "./messages.js";

describe("senderLabel", () => {
  it("drops one trailing Display, Screen, Monitor or Console, in any case", () => {
    assert.equal(senderLabel("riley display"), "riley");
    assert.equal(senderLabel("Sam Display"), "Sam");
    assert.equal(senderLabel("Main Display"), "Main");
    assert.equal(senderLabel("Booth SCREEN"), "Booth");
    assert.equal(senderLabel("Lobby monitor"), "Lobby");
    assert.equal(senderLabel("Producer Console"), "Producer");
  });

  it("keeps a name that is only the word, and a word that is not trailing or whole", () => {
    assert.equal(senderLabel("Display"), "Display");
    assert.equal(senderLabel("  screen  "), "screen");
    assert.equal(senderLabel("Displays Left"), "Displays Left");
    assert.equal(senderLabel("Display Left"), "Display Left");
    assert.equal(senderLabel("MyDisplay"), "MyDisplay");
  });

  it("drops only one, and trims", () => {
    assert.equal(senderLabel("Main Display Screen"), "Main Display");
    assert.equal(senderLabel("  Sam   Display  "), "Sam");
    assert.equal(senderLabel("Booth panel"), "Booth panel");
  });
});
