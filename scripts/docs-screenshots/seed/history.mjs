// seed/history.mjs — recorded services, written into the data dir before the server
// starts.
//
// Attendance, SPL and timeline records are written by the recorders while a real
// service runs; no route creates them, so the screenshot data is files in the
// shapes main/types/history.ts declares. They are written before the server starts
// because the stores cache what they load.
//
// The numbers are invented and deterministic (a seeded generator), so a re-run
// draws the same charts: a Weekend attendance that grows across thirteen weeks
// with a dip in one of them, a second service that runs fuller than the first, and
// levels that sit higher on songs than on speaking.

import fs from "node:fs";
import path from "node:path";

import { RUNDOWN, SERVICE_TYPES, planFor, zonedParts } from "../world.mjs";

const MINUTE = 60_000;

/** Same rule as KeyedRecordStore's filename: a key holds colons. */
const fileName = (key) =>
  `${key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "") || "unknown"}.json`;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = (n) => String(n).padStart(2, "0");
const localDate = (d) => {
  const p = zonedParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
};

/** How many services each type has recorded, and its typical peak room count. */
const PLAN = {
  weekend: { weeks: 13, peaks: [235, 372], growth: 4.2 },
  gathering: { weeks: 9, peaks: [104], growth: 1.3 },
  youth: { weeks: 7, peaks: [71], growth: 1.1 },
};

function attendanceRecord({ type, plan, timeIndex, peak, rand, baseline }) {
  const time = plan.times[timeIndex];
  const start = time.startsAt.getTime();
  const end = start + 78 * MINUTE;
  const first = start - 32 * MINUTE;
  const last = end + 14 * MINUTE;
  const samples = [];
  let attendance = 0;
  let peakOcc = 0;
  let minOcc = Infinity;
  for (let t = first; t <= last; t += 3 * MINUTE) {
    const phase = t < start ? "pre" : t > end ? "post" : undefined;
    let share;
    if (t < start) share = 0.08 + 0.5 * ((t - first) / (start - first)) ** 1.4;
    else if (t <= end) share = 0.58 + 0.42 * Math.min(1, (t - start) / (22 * MINUTE)) - 0.1 * Math.max(0, (t - (end - 14 * MINUTE)) / (14 * MINUTE));
    else share = Math.max(0.05, 0.9 - 0.95 * ((t - end) / (14 * MINUTE)));
    const occupancy = Math.round(peak * share * (0.98 + rand() * 0.04));
    attendance = Math.max(attendance, Math.round(occupancy * 1.04));
    samples.push({ t: new Date(t).toISOString(), attendance, occupancy, ...(phase ? { phase } : {}) });
    if (!phase) {
      peakOcc = Math.max(peakOcc, occupancy);
      minOcc = Math.min(minOcc, occupancy);
    }
  }
  const inService = samples.filter((s) => !s.phase);
  return {
    serviceKey: `${type.id}:${plan.id}:${time.id}`,
    serviceTypeId: type.id,
    serviceTypeName: type.name,
    planId: plan.id,
    planTitle: plan.title,
    seriesTitle: plan.series,
    serviceDate: localDate(time.startsAt),
    serviceTimeId: time.id,
    serviceTimeStartsAt: time.startsAt.toISOString(),
    openingItemId: `${plan.id}01`,
    startedAt: samples[0].t,
    serviceStartedAt: inService[0]?.t ?? null,
    endedAt: new Date(end).toISOString(),
    samples,
    attendanceBaseline: baseline,
    totalAttendance: baseline + attendance,
    peakAttendance: attendance,
    peakOccupancy: peakOcc,
    minOccupancy: Number.isFinite(minOcc) ? minOcc : null,
    lastAttendance: attendance,
    lastOccupancy: samples[samples.length - 1].occupancy,
  };
}

/** Plan items that happen in a service, with the actual length each ran. */
function playedItems(plan, timeIndex, rand) {
  const start = plan.times[timeIndex].startsAt.getTime();
  const preLen = RUNDOWN.slice(0, 3).reduce((s, i) => s + i.len, 0);
  // The service proper (the first song) goes up a little after its scheduled time.
  const late = Math.round((5 + rand() * 80) * 1000);
  let clock = start - preLen * 1000;
  const out = [];
  RUNDOWN.forEach((item, index) => {
    if (item.t === "header") return;
    const overrun = item.title.startsWith("Message") ? 0.96 + rand() * 0.2 : 0.94 + rand() * 0.14;
    let actual = Math.round(item.len * overrun);
    // The last pre-service item runs until the service goes up.
    if (index === 2) actual = Math.round((start + late - clock) / 1000);
    out.push({ item, index, startedAt: clock, endedAt: clock + actual * 1000, actual });
    clock += actual * 1000;
  });
  return out;
}

function timelineRecord({ type, plan, timeIndex, rand }) {
  const time = plan.times[timeIndex];
  const played = playedItems(plan, timeIndex, rand);
  return {
    serviceKey: `${type.id}:${plan.id}:${time.id}`,
    serviceTypeId: type.id,
    serviceTypeName: type.name,
    planId: plan.id,
    planTitle: plan.title,
    seriesTitle: plan.series,
    serviceDate: localDate(time.startsAt),
    serviceTimeId: time.id,
    serviceTimeStartsAt: time.startsAt.toISOString(),
    openingItemId: `${plan.id}01`,
    startedAt: new Date(played[0].startedAt).toISOString(),
    endedAt: new Date(played[played.length - 1].endedAt).toISOString(),
    items: played.map((p, sequence) => ({
      itemId: `${plan.id}${pad2(p.index)}`,
      title: p.item.title,
      sequence,
      plannedLengthSec: p.item.len,
      startedAt: new Date(p.startedAt).toISOString(),
      endedAt: new Date(p.endedAt).toISOString(),
      actualDurationSec: p.actual,
      ...(p.index < 3 ? { preService: true } : {}),
    })),
  };
}

const METER = "main-foh";

function splRecord({ type, plan, timeIndex, rand, bias }) {
  const time = plan.times[timeIndex];
  const played = playedItems(plan, timeIndex, rand);
  const items = played.map((p, sequence) => {
    const base = p.item.t === "song" ? 92.5 : p.item.title.startsWith("Message") ? 84 : p.item.t === "media" ? 78 : 76;
    const leq = +(base + bias + (rand() - 0.5) * 3).toFixed(1);
    const max = +(leq + 5 + rand() * 3).toFixed(1);
    const count = Math.max(10, Math.round(p.actual / 2));
    return {
      itemId: `${plan.id}${pad2(p.index)}`,
      title: p.item.title,
      sequence,
      metrics: { "SPL A Slow": { max, avg: +(leq - 2).toFixed(1), leq, count }, "LAeq 10": { max: +(max - 3).toFixed(1), avg: +(leq - 1).toFixed(1), leq, count } },
      maxSpl: max,
      leqSpl: leq,
      itemType: p.item.t,
      sampleCount: count,
      startedAt: new Date(p.startedAt).toISOString(),
      endedAt: new Date(p.endedAt).toISOString(),
    };
  });
  return {
    serviceKey: `${type.id}:${plan.id}:${time.id}`,
    serviceTypeId: type.id,
    serviceTypeName: type.name,
    planId: plan.id,
    planTitle: plan.title,
    seriesTitle: plan.series,
    serviceDate: localDate(time.startsAt),
    serviceTimeId: time.id,
    serviceTimeStartsAt: time.startsAt.toISOString(),
    openingItemId: `${plan.id}01`,
    meterId: METER,
    metricKey: "SPL A Slow",
    startedAt: items[0].startedAt,
    endedAt: items[items.length - 1].endedAt,
    items,
  };
}

function write(dataDir, dir, record) {
  const target = path.join(dataDir, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, fileName(record.serviceKey)), JSON.stringify(record, null, 2));
}

/** Baptism sessions on recent Weekend services, as baptism.json holds them. */
function baptismFile(now) {
  const sessions = [];
  const type = SERVICE_TYPES[0];
  const counts = { 1: 3, 2: 5, 4: 2, 5: 4, 8: 6, 11: 2 };
  for (const [weeks, people] of Object.entries(counts)) {
    const plan = planFor("weekend", -Number(weeks), now);
    const rand = rng(900 + Number(weeks));
    const time = plan.times[1];
    const startedAt = new Date(time.startsAt.getTime() + 41 * MINUTE);
    let elapsed = 0;
    const list = [];
    for (let i = 0; i < people; i++) {
      const testimonyMs = Math.round((95 + rand() * 90) * 1000);
      const baptizeMs = Math.round((24 + rand() * 30) * 1000);
      elapsed += testimonyMs + baptizeMs;
      list.push({ testimonyMs, baptizeMs });
    }
    sessions.push({
      id: `bap-${startedAt.getTime()}`,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + elapsed + 20_000).toISOString(),
      people: list,
      title: plan.title,
      serviceTypeId: type.id,
      planId: plan.id,
      serviceKey: `${type.id}:${plan.id}:${time.id}`,
    });
  }
  sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { current: null, sessions };
}

/** Write every recorded-history file the screenshots need. */
export function seedHistoryFiles(dataDir, now) {
  for (const type of SERVICE_TYPES) {
    const cfg = PLAN[type.key];
    for (let w = 1; w <= cfg.weeks; w++) {
      const plan = planFor(type.key, -w, now);
      const rand = rng(w * 131 + type.id.charCodeAt(6));
      // Older weeks are smaller; one week in the middle is a holiday dip.
      const trend = (cfg.weeks - w) * cfg.growth;
      const dip = w === 6 ? 0.78 : 1;
      let baseline = 0;
      cfg.peaks.forEach((basePeak, timeIndex) => {
        const peak = Math.round((basePeak * 0.8 + trend * 3) * dip * (0.97 + rand() * 0.06));
        const attendance = attendanceRecord({ type, plan, timeIndex, peak, rand, baseline });
        write(dataDir, "attendance-history", attendance);
        baseline = attendance.totalAttendance;
        write(dataDir, "service-timeline", timelineRecord({ type, plan, timeIndex, rand }));
        // Levels drift up a little over the quarter, and one service ran hot.
        const bias = (cfg.weeks - w) * 0.12 + (w === 3 && type.key === "weekend" && timeIndex === 1 ? 2.8 : 0);
        write(dataDir, "spl-history", splRecord({ type, plan, timeIndex, rand, bias }));
      });
    }
  }
  fs.writeFileSync(path.join(dataDir, "baptism.json"), JSON.stringify(baptismFile(now), null, 2));
}
