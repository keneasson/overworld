// What kind of place a behaviour is, from how much it holds (#1 "Everything is a behaviour"): its size (itself and
// everything under it) and its height (how many levels sit under it). Never from how deep it sits: a city can stand
// beside a village. Height counts as well as size, so twenty loose leaves are a big block, not a city.

/** The legend, smallest first. */
export const PLACE_KINDS = ['house', 'block', 'neighbourhood', 'district', 'town', 'city', 'region', 'province', 'country'];

// The smallest size of each kind (house is anything of size 1).
const AT_LEAST = [1, 2, 13, 31, 61, 121, 251, 501, 1001];

/**
 * @param {number} size   the behaviour plus all its descendants (≥ 1)
 * @param {number} height levels under it (0 for a leaf)
 * @returns {string} one of PLACE_KINDS
 */
export function placeKindOf(size, height = Infinity) {
  let rank = 0;
  while (rank + 1 < AT_LEAST.length && size >= AT_LEAST[rank + 1]) rank++;
  // Each level under it lets it reach two kinds higher: a leaf is a house, one level a block, two a district, three a city.
  const cap = height <= 0 ? 0 : 2 * height - 1;
  return PLACE_KINDS[Math.min(rank, cap)];
}
