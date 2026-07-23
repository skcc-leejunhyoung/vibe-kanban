export const RIGHT_SIDEBAR_SECTION_IDS = [
  'pullRequests',
  'git',
  'commits',
  'terminal',
  'notes',
] as const;

export type RightSidebarSectionId = (typeof RIGHT_SIDEBAR_SECTION_IDS)[number];

export const DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER: RightSidebarSectionId[] = [
  'pullRequests',
  'git',
  'commits',
  'terminal',
  'notes',
];

const RIGHT_SIDEBAR_SECTION_ID_SET = new Set<string>(RIGHT_SIDEBAR_SECTION_IDS);

/**
 * Keeps valid persisted entries in the user's order, drops duplicates/unknown
 * values, then appends newly introduced sections in default order.
 */
export function normalizeRightSidebarSectionOrder(
  order: readonly string[] | null | undefined
): RightSidebarSectionId[] {
  const normalized: RightSidebarSectionId[] = [];
  const seen = new Set<RightSidebarSectionId>();

  for (const value of order ?? []) {
    if (!RIGHT_SIDEBAR_SECTION_ID_SET.has(value)) continue;
    const section = value as RightSidebarSectionId;
    if (seen.has(section)) continue;
    seen.add(section);
    normalized.push(section);
  }

  for (const section of DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER) {
    if (!seen.has(section)) normalized.push(section);
  }

  return normalized;
}
