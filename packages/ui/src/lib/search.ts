function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

/** Matches a query as ordered characters. "프젝" matches "프로젝트". */
export function fuzzySearchMatch(value: string, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return true;

  const normalizedValue = normalizeSearchText(value);
  if (normalizedValue.includes(normalizedQuery)) return true;

  const queryCharacters = Array.from(normalizedQuery);
  let queryIndex = 0;
  for (const character of normalizedValue) {
    if (character === queryCharacters[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === queryCharacters.length) return true;
    }
  }

  return false;
}

export function fuzzySearchMatchAny(
  values: ReadonlyArray<string | null | undefined>,
  query: string
): boolean {
  return values.some(
    (value) => value != null && fuzzySearchMatch(value, query)
  );
}
