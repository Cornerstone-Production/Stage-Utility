// Planning Center Online client (Basic Auth: App ID + Secret).
// Flattens JSON:API responses to slim DTOs. ~30s in-memory cache.

import type { PlanDTO, ServiceTypeDTO, TeamMemberDTO } from "../types/stage.js";

const PCO_BASE = "https://api.planningcenteronline.com/services/v2";
const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Generic JSON:API node from PCO
interface PcoNode {
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data: { id: string; type: string } | null | { id: string; type: string }[] }>;
}

interface PcoResponse<T extends PcoNode = PcoNode> {
  data: T | T[];
  included?: PcoNode[];
}

class PcoService {
  private cache = new Map<string, CacheEntry<unknown>>();

  private cacheGet<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private cacheSet<T>(key: string, value: T): void {
    // Bound cache to 200 entries to avoid unbounded growth.
    if (this.cache.size >= 200) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  clearCache(): void {
    this.cache.clear();
  }

  private makeAuthHeader(appId: string, secret: string): string {
    const creds = Buffer.from(`${appId}:${secret}`).toString("base64");
    return `Basic ${creds}`;
  }

  private async request<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
  ): Promise<PcoResponse<T>> {
    console.log(`[pco] GET ${url}`);
    const response = await fetch(url, {
      headers: {
        Authorization: this.makeAuthHeader(appId, secret),
        "Content-Type": "application/json",
      },
    });

    if (response.status === 401) {
      throw new Error("PCO auth failed — check App ID/Secret in Integrations settings");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`PCO API error ${response.status}: ${body || response.statusText}`);
    }

    const json = await response.json() as PcoResponse<T>;
    console.log(`[pco] OK ${url} (${Array.isArray(json.data) ? (json.data as T[]).length : 1} items)`);
    return json;
  }

  async listServiceTypes(appId: string, secret: string): Promise<ServiceTypeDTO[]> {
    const cacheKey = `service-types:${appId}`;
    const cached = this.cacheGet<ServiceTypeDTO[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types?per_page=100`;
    const json = await this.request(url, appId, secret);
    const items = Array.isArray(json.data) ? json.data : [json.data];

    const result: ServiceTypeDTO[] = items.map((item) => ({
      id: item.id,
      name: String(item.attributes.name ?? "Unknown"),
    }));

    this.cacheSet(cacheKey, result);
    return result;
  }

  async listUpcomingPlans(
    appId: string,
    secret: string,
    serviceTypeId: string,
  ): Promise<PlanDTO[]> {
    const cacheKey = `plans:${appId}:${serviceTypeId}`;
    const cached = this.cacheGet<PlanDTO[]>(cacheKey);
    if (cached) return cached;

    const url = `${PCO_BASE}/service_types/${serviceTypeId}/plans?filter=future&order=sort_date&per_page=25`;
    const json = await this.request(url, appId, secret);
    const items = Array.isArray(json.data) ? json.data : [json.data];

    const result: PlanDTO[] = items.map((item) => ({
      id: item.id,
      title: String(item.attributes.title ?? item.attributes.series_title ?? item.attributes.dates ?? "Untitled"),
      seriesTitle: item.attributes.series_title != null && String(item.attributes.series_title) !== ""
        ? String(item.attributes.series_title)
        : null,
      sortDate: item.attributes.sort_date != null ? String(item.attributes.sort_date) : null,
      dates: item.attributes.dates != null ? String(item.attributes.dates) : null,
    }));

    this.cacheSet(cacheKey, result);
    return result;
  }

  async listTeamMembers(
    appId: string,
    secret: string,
    serviceTypeId: string,
    planId: string,
  ): Promise<TeamMemberDTO[]> {
    const cacheKey = `team:${appId}:${serviceTypeId}:${planId}`;
    const cached = this.cacheGet<TeamMemberDTO[]>(cacheKey);
    if (cached) return cached;

    const url =
      `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/team_members?include=person,team&per_page=100`;
    const json = await this.request(url, appId, secret);
    const items = Array.isArray(json.data) ? json.data : [json.data];

    // Build lookup for included person/team nodes.
    const includedById = new Map<string, PcoNode>();
    for (const node of json.included ?? []) {
      includedById.set(`${node.id}`, node);
    }

    const result: TeamMemberDTO[] = items.map((item) => {
      const personRel = item.relationships?.person?.data;
      const teamRel = item.relationships?.team?.data;

      let personId: string | null = null;
      let photoUrl: string | null = null;
      let teamName: string | null = null;

      if (personRel && !Array.isArray(personRel)) {
        personId = personRel.id;
        const personNode = includedById.get(personRel.id);
        if (personNode) {
          // PCO Person exposes photo_thumbnail_url / photo_url; try variants.
          const attrs = personNode.attributes;
          photoUrl =
            (attrs.photo_thumbnail_url != null && String(attrs.photo_thumbnail_url)) ||
            (attrs.photo_url != null && String(attrs.photo_url)) ||
            (attrs.avatar != null && String(attrs.avatar)) ||
            (attrs.photo_thumbnail != null && String(attrs.photo_thumbnail)) ||
            null;
        }
        // Fall back to photo fields on the team_member item itself.
        if (!photoUrl) {
          const a = item.attributes;
          photoUrl =
            (a.photo_thumbnail_url != null && String(a.photo_thumbnail_url)) ||
            (a.photo_url != null && String(a.photo_url)) ||
            (a.avatar != null && String(a.avatar)) ||
            (a.photo_thumbnail != null && String(a.photo_thumbnail)) ||
            null;
        }
      }

      if (teamRel && !Array.isArray(teamRel)) {
        const teamNode = includedById.get(teamRel.id);
        if (teamNode) {
          teamName = teamNode.attributes.name != null ? String(teamNode.attributes.name) : null;
        }
      }

      return {
        id: item.id,
        name: String(item.attributes.name ?? "Unknown"),
        personId,
        photoUrl,
        teamPositionName:
          item.attributes.team_position_name != null
            ? String(item.attributes.team_position_name)
            : null,
        teamName,
        status: String(item.attributes.status ?? "U"),
      };
    });

    this.cacheSet(cacheKey, result);
    return result;
  }
}

export const pcoService = new PcoService();
