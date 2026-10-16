// seed/patch.mjs — a stage patch sheet, with a Weekend standard and a variant that
// changes two channels this week.

import { SERVICE_TYPES, planFor } from "../world.mjs";

const INPUTS = [
  ["Kick In", "Beta 91A", false],
  ["Snare Top", "SM57", false],
  ["Snare Bottom", "SM57", false],
  ["Hi-Hat", "KSM137", true],
  ["Tom 1", "e604", false],
  ["Tom 2", "e604", false],
  ["Floor Tom", "e604", false],
  ["Overhead L", "KSM137", true],
  ["Overhead R", "KSM137", true],
  ["Bass DI", "Radial JDI", true],
  ["Electric Guitar", "SM57", false],
  ["Acoustic DI", "Radial JDI", true],
  ["Keys L", "DI", true],
  ["Keys R", "DI", true],
  ["Track L", "DI", false],
  ["Track R", "DI", false],
  ["Worship Lead", "Wireless", false],
  ["Vocal 2", "Wireless", false],
  ["Vocal 3", "Wireless", false],
  ["Host", "Wireless", false],
  ["Pastor", "Wireless", false],
  ["Lectern", "SM58", false],
  ["Pulpit Spare", "Wireless", false],
  ["Talkback", "SM58", false],
];

export async function seedPatch(api, now) {
  const sheetId = "sheet-stage";
  const devices = [
    { id: "dev-sd", name: "SD Rack", kind: "rack", inputs: 48, outputs: 24, color: "#2563eb" },
    { id: "dev-snake", name: "Stage Snake", kind: "snake", inputs: 24, outputs: 8, color: "#16a34a" },
    { id: "dev-pocket", name: "Floor Pocket SL", kind: "pocket", inputs: 8, outputs: 0, color: "#ca8a04" },
    { id: "dev-rf", name: "Wireless Rack", kind: "wireless", inputs: 8, outputs: 0, color: "#9333ea" },
  ];
  const endpoints = INPUTS.map(([label, mic, phantom], i) => {
    const wireless = mic === "Wireless";
    const hop = wireless
      ? { deviceId: "dev-rf", connector: String((i % 8) + 1) }
      : { deviceId: "dev-snake", connector: String(i + 1) };
    return {
      rackId: "dev-sd",
      dir: "in",
      index: i + 1,
      consoleChannel: String(i + 1),
      label,
      mic,
      phantom,
      path: [hop],
      ...(i < 10 ? { owner: "Drums and Bass" } : i < 16 ? { owner: "Band" } : { owner: "Vocals and Speakers" }),
    };
  });
  const outputs = [
    ["Wedge 1", "wedge"],
    ["Wedge 2", "wedge"],
    ["Wedge 3", "wedge"],
    ["IEM Mix 1", "IEM"],
    ["IEM Mix 2", "IEM"],
    ["IEM Mix 3", "IEM"],
    ["Stream Mix", "stream"],
    ["Record Mix", "record"],
  ].map(([label, feedType], i) => ({
    rackId: "dev-sd",
    dir: "out",
    index: i + 1,
    consoleChannel: `Aux ${i + 1}`,
    label,
    feedType,
    path: [{ deviceId: "dev-snake", connector: String(i + 1) }],
  }));

  const plan = planFor("weekend", 0, now);
  const variant = {
    id: "var-weekend",
    name: "Weekend with Choir",
    overrides: {
      "dev-sd:in:11": { label: "Choir Mic L", mic: "KM184", phantom: true },
      "dev-sd:in:12": { label: "Choir Mic R", mic: "KM184", phantom: true },
      "dev-sd:in:23": { unused: true },
    },
  };
  const file = {
    sheets: [
      {
        id: sheetId,
        name: "Stage Patch",
        kind: "analog",
        devices,
        endpoints: [...endpoints, ...outputs],
        variants: [variant],
        assignments: {
          byServiceType: { [SERVICE_TYPES[0].id]: variant.id },
          byPlan: { [plan.id]: { tweaks: { "dev-sd:in:24": { label: "Talkback (Booth)" } } } },
        },
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  await api.post("/api/patch", { file });
}
