/**
 * Makes user text literal inside a Postgres LIKE / ILIKE pattern, for Prisma's `contains`,
 * `startsWith` and `endsWith` filters.
 *
 * Why: Prisma 7.10.1 does NOT escape the value of these filters; it sends e.g. `contains` as
 * `ILIKE ('%' || $1 || '%')`, so `%` (any run of characters) and `_` (any one character) in a
 * search term act as wildcards: searching "50%" would also match "500 Days". Postgres's
 * default LIKE escape character is the backslash, so prefixing each `\`, `%` and `_` with a
 * backslash makes it match only itself. The backslash is escaped too (and first, in the same
 * pass), so a term ending in `\` cannot escape the closing `%` Prisma appends.
 *
 * Only for values passed to contains / startsWith / endsWith. Never use it for `equals` or
 * other filters, which compare literally: the added backslashes would then be searched for.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}
