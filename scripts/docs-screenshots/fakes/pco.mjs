// fakes/pco.mjs — a stand-in for the Planning Center Services API, answering from
// the invented world.
//
// The app pins every credentialed request to api.planningcenteronline.com (that is
// deliberate and stays), so this cannot be a server the app is pointed at. The
// preload (../preload.mjs) swaps `fetch` inside the screenshot server's own
// process for a function that calls handlePco() when the host is Planning
// Center's, and leaves every other request alone. Nothing in the app changes.
//
// Only the endpoints the app reads are answered; anything else is a 404, which the
// app handles the way it handles a Planning Center 404.

import {
  ITEM_NOTE_CATEGORIES,
  LIVE_ITEM_INDEX,
  LIVE_PLAN_ID,
  ORG_TIME_ZONE,
  PEOPLE,
  ROSTERS,
  RUNDOWN,
  SERVICE_TYPES,
  TEAMS,
  liveWeekendPlan,
  plansFor,
} from "../world.mjs";

const MINUTE = 60_000;
const iso = (d) => new Date(d).toISOString();

/**
 * Every plan Planning Center has right now. In live mode the Weekend service that
 * is under way (world.mjs liveWeekendPlan) is listed too, with an item on air.
 */
function allPlans(now, live) {
  const plans = SERVICE_TYPES.flatMap((t) => plansFor(t.key, now));
  return live ? [...plans, liveWeekendPlan(now)] : plans;
}

const planNode = (p) => ({
  type: "Plan",
  id: p.id,
  attributes: {
    title: p.title,
    series_title: p.series,
    sort_date: iso(p.times[0].startsAt),
    dates: p.dates,
  },
});

const itemId = (plan, index) => `${plan.id}${String(index).padStart(2, "0")}`;

function itemsBody(plan) {
  const data = [];
  const included = [];
  RUNDOWN.forEach((item, index) => {
    const relationships = {};
    if (item.notes) {
      const refs = Object.entries(item.notes).map(([category, content]) => {
        const id = `${itemId(plan, index)}${ITEM_NOTE_CATEGORIES.indexOf(category)}`;
        included.push({ type: "ItemNote", id, attributes: { category_name: category, content } });
        return { type: "ItemNote", id };
      });
      relationships.item_notes = { data: refs };
    }
    if (item.arr) {
      const id = `${itemId(plan, index)}9`;
      included.push({ type: "Arrangement", id, attributes: { bpm: item.bpm, meter: item.meter, name: item.arr } });
      relationships.arrangement = { data: { type: "Arrangement", id } };
    }
    data.push({
      type: "Item",
      id: itemId(plan, index),
      attributes: {
        title: item.title,
        item_type: item.t,
        length: item.len,
        sequence: index + 1,
        description: null,
        key_name: item.key ?? null,
        service_position: item.t === "header" ? null : index < 4 ? "pre" : "during",
      },
      relationships,
    });
  });
  return { data, included };
}

function teamMembersBody(plan) {
  const roster = ROSTERS[plan.typeKey];
  const data = [];
  const included = [];
  const teamsSeen = new Set();
  roster.forEach(([name, team, position, note], index) => {
    const person = PEOPLE.find((p) => p.name === name);
    const teamDef = TEAMS.find((t) => t.name === team);
    data.push({
      type: "PlanPerson",
      id: `${plan.id}${String(index).padStart(2, "0")}`,
      attributes: { name, team_position_name: position, status: "C", notes: note || null },
      relationships: {
        person: { data: { type: "Person", id: person.id } },
        team: { data: { type: "Team", id: teamDef.id } },
      },
    });
    included.push({ type: "Person", id: person.id, attributes: { full_name: name } });
    if (!teamsSeen.has(teamDef.id)) {
      teamsSeen.add(teamDef.id);
      included.push({ type: "Team", id: teamDef.id, attributes: { name: team } });
    }
  });
  return { data, included };
}

function teamsBody() {
  const data = [];
  const included = [];
  for (const team of TEAMS) {
    const refs = team.positions.map((name, i) => {
      const id = `${team.id}${i}`;
      included.push({ type: "TeamPosition", id, attributes: { name } });
      return { type: "TeamPosition", id };
    });
    data.push({
      type: "Team",
      id: team.id,
      attributes: { name: team.name },
      relationships: { team_positions: { data: refs } },
    });
  }
  return { data, included };
}

function liveBody(plan, live) {
  if (!live || plan.id !== LIVE_PLAN_ID) {
    return { data: { type: "Live", id: plan.id, attributes: {}, relationships: {} } };
  }
  const id = itemId(plan, LIVE_ITEM_INDEX);
  return {
    data: {
      type: "Live",
      id: plan.id,
      attributes: {},
      relationships: { current_item_time: { data: { type: "ItemTime", id: `${id}1` } } },
    },
    included: [
      {
        type: "ItemTime",
        id: `${id}1`,
        attributes: { live_start_at: iso(Date.now() - 95_000), length_offset: 0 },
        relationships: { item: { data: { type: "Item", id } } },
      },
    ],
  };
}

const ok = (body) => ({ status: 200, body });
const missing = () => ({ status: 404, body: { errors: [{ title: "Not Found", status: "404" }] } });

/**
 * Answer one Services API GET.
 *
 * @param {string} pathname  the path after /services/v2, no query ("" = the organisation)
 * @param {URLSearchParams} query
 * @param {{ now: Date, live: boolean }} state
 */
export function handlePco(pathname, query, state) {
  const { now, live } = state;
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return ok({ data: { type: "Organization", id: "1", attributes: { time_zone: ORG_TIME_ZONE } } });
  }
  if (parts[0] === "people" && parts.length === 2) {
    const person = PEOPLE.find((p) => p.id === parts[1]);
    return person ? ok({ data: { type: "Person", id: person.id, attributes: { full_name: person.name } } }) : missing();
  }
  if (parts[0] !== "service_types") return missing();

  if (parts.length === 1) {
    return ok({
      data: SERVICE_TYPES.map((t) => ({ type: "ServiceType", id: t.id, attributes: { name: t.name } })),
    });
  }

  const type = SERVICE_TYPES.find((t) => t.id === parts[1]);
  if (!type) return missing();
  const section = parts[2];

  if (parts.length === 3) {
    if (section === "plans") {
      const mine = allPlans(now, live).filter((p) => p.typeId === type.id);
      const filter = query.get("filter");
      const cutoff = now.getTime();
      const future = mine.filter((p) => p.times[0].startsAt.getTime() >= cutoff - 6 * 3_600_000);
      const past = mine.filter((p) => !future.includes(p));
      if (filter === "future") return ok({ data: future.sort((a, b) => a.times[0].startsAt - b.times[0].startsAt).map(planNode) });
      if (filter === "past") return ok({ data: past.sort((a, b) => b.times[0].startsAt - a.times[0].startsAt).map(planNode) });
      return ok({ data: mine.map(planNode) });
    }
    if (section === "teams") return ok(teamsBody());
    if (section === "item_note_categories") {
      return ok({ data: ITEM_NOTE_CATEGORIES.map((name, i) => ({ type: "ItemNoteCategory", id: String(900 + i), attributes: { name, sequence: i } })) });
    }
    if (section === "plan_note_categories") return ok({ data: [] });
    return missing();
  }

  if (section === "teams" && parts.length === 5 && parts[4] === "team_positions") {
    const team = TEAMS.find((t) => t.id === parts[3]);
    return team
      ? ok({ data: team.positions.map((name, i) => ({ type: "TeamPosition", id: `${team.id}${i}`, attributes: { name } })) })
      : missing();
  }

  if (section !== "plans") return missing();
  const plan = allPlans(now, live).find((p) => p.id === parts[3] && p.typeId === type.id);
  if (!plan) return missing();
  const leaf = parts[4];

  if (leaf === "plan_times") {
    const data = [
      ...plan.times.map((t) => ({
        type: "PlanTime",
        id: t.id,
        attributes: { time_type: "service", name: null, starts_at: iso(t.startsAt), ends_at: iso(t.endsAt) },
      })),
      {
        type: "PlanTime",
        id: `${plan.id}8`,
        attributes: { time_type: "rehearsal", name: "Rehearsal", starts_at: iso(plan.rehearsal), ends_at: iso(plan.rehearsal.getTime() + 120 * MINUTE) },
      },
    ];
    return ok({ data });
  }
  if (leaf === "items") return ok(itemsBody(plan));
  if (leaf === "team_members") return ok(teamMembersBody(plan));
  if (leaf === "notes") return ok({ data: [] });
  if (leaf === "all_attachments") return ok({ data: [] });
  if (leaf === "live" && parts.length === 5) return ok(liveBody(plan, live));
  return missing();
}
