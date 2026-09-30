import { describe, expect, test } from "bun:test";
import { searchCatalog } from "../../../src/lib/catalogSearch.ts";

const catalog = Array.from({ length: 5000 }, (_, index) => ({
  name: `team-${String(index).padStart(4, "0")}-platform`,
}));
describe("optional catalog search", () => {
  test("empty or whitespace search shows ALL entries in their existing order", () => {
    for (const query of ["", "   "]) {
      const result = searchCatalog(catalog, query, item => item.name);
      expect(result.items).toEqual(catalog);
      expect(result.matched).toBe(5000);
      expect(result.total).toBe(5000);
    }
  });
  test("searches the full catalog with case-insensitive AND keywords", () => {
    const result = searchCatalog(catalog, "  PLATFORM 4999 TeAM  ", item => item.name);
    expect(result.items).toEqual([catalog[4999]]);
    expect(result.matched).toBe(1);
    expect(result.total).toBe(5000);
  });
  test("matching results are never capped or reordered", () => {
    const result = searchCatalog(catalog, "team platform", item => item.name);
    expect(result.items).toEqual(catalog);
    expect(result.items.length).toBe(5000);
  });
  test("matching treats punctuation literally and reports empty results", () => {
    const result = searchCatalog(catalog, ".*", item => item.name);
    expect(result.items).toEqual([]);
    expect(result.matched).toBe(0);
    expect(result.total).toBe(5000);
  });
});
