// photo-themes-harness.ts — a fake OpenAI and the parts of the server photo
// themes leans on, for its tests. The real API is never called from a test.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import sharp from "sharp";

import type { PhotoThemesDeps, PlanPerson, PlanPeopleRead } from "./service.js";

export interface FakeRequest {
  path: string;
  method: string;
  authorization: string | undefined;
  /** The multipart field names an edit was sent with. */
  fields: string[];
}

export interface FakeAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeOpenAi {
  /** The base URL to put in STAGE_UTILITY_OPENAI_BASE_URL. */
  base: string;
  requests: FakeRequest[];
  /** What /v1/images/edits answers; the default is a small WebP. */
  edit: (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;
  /** What /v1/models answers. */
  models: (req: FakeRequest) => FakeAnswer;
  edits(): number;
  close(): Promise<void>;
}

let webp: Buffer | null = null;

/** A real 24x36 WebP: what a successful edit returns. */
export async function webpBytes(): Promise<Buffer> {
  webp ??= await sharp({ create: { width: 24, height: 36, channels: 3, background: { r: 200, g: 40, b: 40 } } }).webp().toBuffer();
  return webp;
}

/** A real JPEG, standing in for a Planning Center photo. */
export async function jpegBytes(shade = 120): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: shade, g: shade, b: shade } } }).jpeg().toBuffer();
}

/** OpenAI's own error body, carrying the key back in its message the way a 401 does. */
export function errorBody(code: string | null, type: string | null, echo = ""): unknown {
  return { error: { message: `Incorrect API key provided: ${echo}`, code, type, param: null } };
}

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const fake: FakeOpenAi = {
    base: "",
    requests: [],
    edit: async () => ({ status: 200, body: { created: 1, data: [{ b64_json: (await webpBytes()).toString("base64") }] } }),
    models: () => ({ status: 200, body: { object: "list", data: [] } }),
    edits: () => fake.requests.filter((r) => r.path.endsWith("/images/edits")).length,
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("latin1");
        const fields = [...raw.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]!);
        const r: FakeRequest = { path: req.url ?? "", method: req.method ?? "", authorization: req.headers.authorization, fields };
        fake.requests.push(r);
        const answer = r.path.endsWith("/images/edits") ? await fake.edit(r) : r.path.endsWith("/models") ? fake.models(r) : { status: 404, body: {} };
        res.writeHead(answer.status, { "Content-Type": "application/json", ...(answer.headers ?? {}) });
        res.end(JSON.stringify(answer.body));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}

/** A Planning Center photo address for a person, at a given upload. */
export function pcoPhoto(personId: string, upload = 1): string {
  return `https://avatars.planningcenteronline.com/uploads/person/${personId}-${upload}/avatar.jpg?g=256x256%23`;
}

export interface FakeServer {
  deps: PhotoThemesDeps;
  /** Who each plan's boards put in a slot, by plan id. */
  rosters: Map<string, PlanPerson[]>;
  /** A plan whose roster cannot be read, and why. */
  unreadable: Map<string, string>;
  /** Times onShownChanged was called. */
  shownChanges: number;
  /** The originals loaded, by URL. */
  loads: string[];
  currentSortDate: string | null;
}

/** The server around the service: rosters, originals, the redraw hook. */
export async function fakeServer(fetchImpl?: typeof fetch): Promise<FakeServer> {
  const original = await jpegBytes();
  const s: FakeServer = {
    rosters: new Map(),
    unreadable: new Map(),
    shownChanges: 0,
    loads: [],
    currentSortDate: null,
    deps: undefined as unknown as PhotoThemesDeps,
  };
  s.deps = {
    planPeople: async (_serviceTypeId, planId): Promise<PlanPeopleRead> => {
      const why = s.unreadable.get(planId);
      if (why) return { roster: "unavailable", reason: why, people: [] };
      return { roster: "plan", people: s.rosters.get(planId) ?? [] };
    },
    currentPhotoOf: (personId) => {
      for (const people of s.rosters.values()) {
        const p = people.find((x) => x.personId === personId);
        if (p?.photoUrl) return p.photoUrl;
      }
      return undefined;
    },
    currentPlanSortDate: () => s.currentSortDate,
    onShownChanged: () => {
      s.shownChanges++;
    },
    loadOriginal: async (url) => {
      s.loads.push(url);
      return original;
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  return s;
}
