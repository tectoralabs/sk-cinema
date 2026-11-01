import { slugSchema } from '@sk-cinema/shared';

/** Longest slug the database and `slugSchema` accept. */
export const SLUG_MAX_LENGTH = 160;

/** Longest slug `slugify` produces, leaving room for a `-<n>` suffix within SLUG_MAX_LENGTH. */
export const SLUG_BASE_MAX_LENGTH = 150;

/**
 * Latin letters that NFKD does not decompose into an ASCII base letter plus combining marks.
 * Applied after lowercasing, so only lowercase forms are needed.
 */
const LATIN_FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
};

const LATIN_FOLD_PATTERN = new RegExp(`[${Object.keys(LATIN_FOLDS).join('')}]`, 'g');

/**
 * Shortens a well-formed slug to at most `max` characters, cutting at a hyphen so that words
 * are kept whole when possible, otherwise hard-cutting. Never leaves a trailing hyphen.
 */
function truncateSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  // The next character is a hyphen, so `cut` already ends on a whole word.
  if (slug[max] === '-') return cut;
  const lastHyphen = cut.lastIndexOf('-');
  if (lastHyphen > 0) return cut.slice(0, lastHyphen);
  return cut.replace(/-+$/, '');
}

/**
 * Turns a movie title into a URL slug: accents folded to ASCII, lowercase, runs of anything
 * other than `a-z0-9` collapsed to one hyphen, capped at SLUG_BASE_MAX_LENGTH characters.
 *
 * Contract: returns `''` when nothing usable remains (e.g. a Sinhala- or Tamil-only title, or
 * only punctuation/emoji). There is deliberately no fallback value; callers must treat `''` as
 * "ask the admin to supply a slug". Every non-empty result passes `slugSchema`.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(LATIN_FOLD_PATTERN, (ch) => LATIN_FOLDS[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlug(slug, SLUG_BASE_MAX_LENGTH);
}

/**
 * Returns `base` for n = 1 and `${base}-${n}` for n >= 2, shortening `base` (at a hyphen when
 * possible) so the result stays within SLUG_MAX_LENGTH. Deterministic for a given (base, n).
 *
 * Throws for an empty or malformed base, or n that is not a positive integer: these are
 * programming errors, not user input errors.
 */
export function withSuffix(base: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`withSuffix: n must be a positive integer, got ${String(n)}`);
  }
  if (!slugSchema.safeParse(base).success) {
    throw new TypeError('withSuffix: base must be a non-empty, well-formed slug');
  }
  if (n === 1) return base;
  const suffix = `-${String(n)}`;
  return `${truncateSlug(base, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
}

const DIGITS = /^[0-9]+$/;

/**
 * True for `base` itself and `${base}-<digits>`: every slug `firstFreeSlug(base, ...)` can
 * produce for a slugify() base (at most SLUG_BASE_MAX_LENGTH characters, so withSuffix never
 * shortens it). Other slugs sharing the prefix, e.g. `the-batman` for base `the`, can never be
 * a candidate. Plain string checks: nothing is compiled from the base.
 */
export function isSlugOrSuffixed(slug: string, base: string): boolean {
  if (slug === base) return true;
  return slug.startsWith(`${base}-`) && DIGITS.test(slug.slice(base.length + 1));
}

/**
 * Returns the first `withSuffix(base, n)` (n = 1, 2, 3, ...) that is not in `taken`.
 * Pure: the caller supplies the slugs already in use.
 */
export function firstFreeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const candidate = withSuffix(base, n);
    if (!used.has(candidate)) return candidate;
  }
}
