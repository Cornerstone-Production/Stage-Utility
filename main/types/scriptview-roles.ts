/** A named set of PCO note-category names that mean the same thing.
 *
 *  Category names are defined PER SERVICE TYPE and vary — one church was measured with
 *  29 distinct names across 20 service types, including "Audio" and "Audio/Visual" for
 *  the same role, three spellings of "MD + Playback Tech", and case variants of
 *  "EG 1 (Lead)". A layout column references a role, so it resolves correctly whatever
 *  the service type calls it. */
export interface CategoryRole {
  id: string;
  /** Shown as the column header. */
  name: string;
  /** PCO category names, IN PRIORITY ORDER — see resolveRole(). */
  members: string[];
}
