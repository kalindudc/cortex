// Optional keyword filtering shared by lane/tag pickers. Empty search
// returns every entry in the caller's order. There is deliberately no cap,
// pagination, priority reshuffling, or regex/query-language interpretation.
export interface CatalogSearchResult<T> {
  items: T[];
  matched: number;
  total: number;
}

export function searchCatalog<T>(
  catalog: readonly T[],
  query: string,
  text: (item: T) => string,
): CatalogSearchResult<T> {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = catalog.filter(item => {
    const name = text(item).toLowerCase();
    return tokens.every(token => name.includes(token));
  });
  return { items, matched: items.length, total: catalog.length };
}

export function catalogSearchHint(result: CatalogSearchResult<unknown>): string {
  return `${result.matched} of ${result.total} entries`;
}
