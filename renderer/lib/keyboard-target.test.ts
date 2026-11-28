import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
const { isTypingTarget, modalOpen, isMod } = await import("./keyboard-target.js");

afterEach(() => { document.body.innerHTML = ""; });
after(() => teardown());

const put = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
};

describe("modalOpen", () => {
  test("a listbox counts only when asked", () => {
    put('<div role="listbox"></div>');
    assert.equal(modalOpen(), false);
    assert.equal(modalOpen({ listbox: true }), true);
  });
  for (const role of ["dialog", "alertdialog", "menu"]) {
    test(`a ${role} is open`, () => {
      put(`<div role="${role}"></div>`);
      assert.equal(modalOpen(), true);
    });
  }
  test("nothing is open", () => {
    put("<div role='group'></div>");
    assert.equal(modalOpen(), false);
  });
});

describe("isTypingTarget", () => {
  test("fields and their descendants", () => {
    for (const html of ["<input>", "<textarea></textarea>", "<select></select>", "<div contenteditable='true'><b>x</b></div>", "<div contenteditable><b>x</b></div>"]) {
      const el = put(html);
      assert.equal(isTypingTarget(el.querySelector("b") ?? el), true, html);
    }
  });
  test("a button, a plain div, null", () => {
    assert.equal(isTypingTarget(put("<button></button>")), false);
    assert.equal(isTypingTarget(put("<div contenteditable='false'></div>")), false);
    assert.equal(isTypingTarget(null), false);
  });
  test("textOnly lets a checkbox through but not a text input", () => {
    assert.equal(isTypingTarget(put("<input type='checkbox'>"), { textOnly: true }), false);
    assert.equal(isTypingTarget(put("<input type='checkbox'>")), true);
    assert.equal(isTypingTarget(put("<input type='search'>"), { textOnly: true }), true);
    assert.equal(isTypingTarget(put("<select></select>"), { textOnly: true }), true);
  });
});

test("isMod takes either command key", () => {
  assert.equal(isMod({ metaKey: true, ctrlKey: false }), true);
  assert.equal(isMod({ metaKey: false, ctrlKey: true }), true);
  assert.equal(isMod({ metaKey: false, ctrlKey: false }), false);
});
