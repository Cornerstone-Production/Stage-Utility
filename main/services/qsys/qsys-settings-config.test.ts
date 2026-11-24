import assert from "node:assert/strict";
import { test } from "node:test";
import { qsysTestMessage } from "./qsys-test-message.js";
import { QSYS_MAX_HZ, QSYS_MIN_HZ, clampRate, splitQsysConfig } from "./qsys-settings-config.js";

const status = { State: "Active" as const, DesignName: "Lobby Design", DesignCode: "c1", IsRedundant: false, IsEmulator: false };

test("a successful test says which design it reached and how many components it read", () => {
  assert.deepEqual(qsysTestMessage({ ok: true, status, components: 12 }), {
    ok: true,
    message: "Connected to Lobby Design — 12 component(s)",
  });
});

test("an emulator is named as one", () => {
  const r = qsysTestMessage({ ok: true, status: { ...status, IsEmulator: true }, components: 1 });
  assert.equal(r.message, "Connected to Lobby Design (emulator) — 1 component(s)");
});

test("a failed test carries the reason, not a success", () => {
  assert.deepEqual(qsysTestMessage({ ok: false, error: "connection refused" }), { ok: false, message: "connection refused" });
});

test("a meter rate is a whole number per second between 1 and 30", () => {
  assert.equal(QSYS_MIN_HZ, 1);
  assert.equal(QSYS_MAX_HZ, 30);
  assert.equal(clampRate(0, 10), 1);
  assert.equal(clampRate(-5, 10), 1);
  assert.equal(clampRate(100, 10), 30);
  assert.equal(clampRate(7.6, 10), 8);
});

test("a meter rate that is not a number falls back to its default", () => {
  assert.equal(clampRate("fast", 10), 10);
  assert.equal(clampRate(null, 20), 20);
  assert.equal(clampRate(Number.NaN, 20), 20);
  assert.equal(clampRate(Infinity, 20), 20);
});

test("the two rates leave the config body for the rates store; everything else stays", () => {
  const body = { host: "10.0.0.5", port: 1710, user: "op", volunteerMeterHz: 15, staffMeterHz: 25 };
  const { rest, rates } = splitQsysConfig(body);
  assert.deepEqual(rates, { volunteerMeterHz: 15, staffMeterHz: 25 });
  assert.deepEqual({ ...rest }, { host: "10.0.0.5", port: 1710, user: "op" });
});

test("a body carrying one rate changes only that rate", () => {
  const { rest, rates } = splitQsysConfig({ host: "h", staffMeterHz: 99 });
  assert.deepEqual(rates, { staffMeterHz: 30 });
  assert.deepEqual({ ...rest }, { host: "h" });
});

test("a body with no rate leaves the stored rates alone", () => {
  const { rates } = splitQsysConfig({ host: "h" });
  assert.deepEqual(rates, {});
});

test("a rate that is not a number is dropped rather than stored as the default", () => {
  // The caller would otherwise overwrite an operator's 15 with 10 on a malformed body.
  const { rates } = splitQsysConfig({ volunteerMeterHz: "fast", staffMeterHz: "" });
  assert.deepEqual(rates, {});
});
