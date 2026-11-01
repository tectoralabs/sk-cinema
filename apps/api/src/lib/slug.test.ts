import { slugSchema } from '@sk-cinema/shared';
import { describe, expect, it } from 'vitest';
import {
  firstFreeSlug,
  isSlugOrSuffixed,
  SLUG_BASE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  slugify,
  withSuffix,
} from './slug.js';

function expectValidSlug(slug: string) {
  expect(slugSchema.safeParse(slug).success).toBe(true);
}

describe('slugify', () => {
  it.each([
    ['Monsoon Over Galle', 'monsoon-over-galle'],
    ['Amélie!!', 'amelie'],
    ['Crème Brûlée', 'creme-brulee'],
    ['Señor Niño Ångström', 'senor-nino-angstrom'],
    ['Straße Æon Œuvre Ørsted Łódź', 'strasse-aeon-oeuvre-orsted-lodz'],
    ['  Mission: Impossible — Dead Reckoning (2023) ', 'mission-impossible-dead-reckoning-2023'],
    ['Gajaman සිංහල 2', 'gajaman-2'],
    ['ＦＵＬＬ　ｗｉｄｔｈ ２', 'full-width-2'],
    ['--a--b--', 'a-b'],
    ['ALREADY-a-slug', 'already-a-slug'],
  ])('slugifies %j to %j', (title, expected) => {
    const slug = slugify(title);
    expect(slug).toBe(expected);
    expectValidSlug(slug);
  });

  it.each([
    ['Sinhala only', 'සිංහල චිත්‍රපටය'],
    ['Tamil only', 'தமிழ் திரைப்படம்'],
    ['punctuation only', '!!!'],
    ['emoji only', '🎬🍿 🎥'],
    ['whitespace only', '   '],
    ['empty', ''],
  ])('returns an empty string when nothing usable remains (%s)', (_label, title) => {
    expect(slugify(title)).toBe('');
  });

  it('caps long titles at a word boundary without a trailing hyphen', () => {
    const title = Array.from({ length: 40 }, (_, i) => `word${String(i)}`).join(' ');
    const slug = slugify(title);
    expect(slug.length).toBeLessThanOrEqual(SLUG_BASE_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    // Each word survives whole: the slug is a prefix of the full slug ending at a word end.
    const full = title.replace(/ /g, '-');
    expect(full.startsWith(slug)).toBe(true);
    expect(full[slug.length]).toBe('-');
    expectValidSlug(slug);
  });

  it('keeps exactly 150 characters when a hyphen falls right after the cut', () => {
    const title = `${'a'.repeat(SLUG_BASE_MAX_LENGTH)} tail`;
    expect(slugify(title)).toBe('a'.repeat(SLUG_BASE_MAX_LENGTH));
  });

  it('does not leave a trailing hyphen when the cut lands on one', () => {
    const title = `${'a'.repeat(SLUG_BASE_MAX_LENGTH - 1)} bbbb`;
    expect(slugify(title)).toBe('a'.repeat(SLUG_BASE_MAX_LENGTH - 1));
  });

  it('hard-cuts a single long word to 150 characters', () => {
    const slug = slugify('x'.repeat(200));
    expect(slug).toBe('x'.repeat(SLUG_BASE_MAX_LENGTH));
    expectValidSlug(slug);
  });
});

describe('withSuffix', () => {
  it('returns the base unchanged for n = 1', () => {
    expect(withSuffix('monsoon-over-galle', 1)).toBe('monsoon-over-galle');
  });

  it.each([
    [2, 'monsoon-over-galle-2'],
    [10, 'monsoon-over-galle-10'],
  ])('appends -%i', (n, expected) => {
    const slug = withSuffix('monsoon-over-galle', n);
    expect(slug).toBe(expected);
    expectValidSlug(slug);
  });

  it('shortens a 160-character single-word base to fit the suffix', () => {
    const base = 'x'.repeat(SLUG_MAX_LENGTH);
    for (const n of [2, 10, 123]) {
      const slug = withSuffix(base, n);
      expect(slug.length).toBe(SLUG_MAX_LENGTH);
      expect(slug.endsWith(`-${String(n)}`)).toBe(true);
      expectValidSlug(slug);
    }
  });

  it('shortens a 160-character multi-word base at a hyphen', () => {
    const base = `${'a'.repeat(100)}-${'b'.repeat(59)}`;
    expect(base).toHaveLength(SLUG_MAX_LENGTH);
    const slug = withSuffix(base, 2);
    expect(slug).toBe(`${'a'.repeat(100)}-2`);
    expectValidSlug(slug);
  });

  it('never needs to shorten a slugify result', () => {
    const base = slugify('y'.repeat(300));
    expect(withSuffix(base, 999)).toBe(`${base}-999`);
  });

  it('is deterministic', () => {
    const base = 'z'.repeat(SLUG_MAX_LENGTH);
    expect(withSuffix(base, 7)).toBe(withSuffix(base, 7));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('throws for n = %s', (n) => {
    expect(() => withSuffix('movie', n)).toThrow(RangeError);
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'Movie'],
    ['trailing hyphen', 'movie-'],
    ['too long', 'x'.repeat(SLUG_MAX_LENGTH + 1)],
  ])('throws for a %s base', (_label, base) => {
    expect(() => withSuffix(base, 2)).toThrow(TypeError);
  });
});

describe('isSlugOrSuffixed', () => {
  it.each(['the', 'the-2', 'the-10', 'the-2026', 'the-02'])('keeps %s for base "the"', (slug) => {
    expect(isSlugOrSuffixed(slug, 'the')).toBe(true);
  });

  it.each(['theatre', 'the-', 'the-batman', 'the-2-towers', 'the-2x', 'the-x2', 'th', 'a-the-2'])(
    'drops %s for base "the"',
    (slug) => {
      expect(isSlugOrSuffixed(slug, 'the')).toBe(false);
    },
  );

  it('keeps every slug firstFreeSlug can produce from a slugify() base, even the longest', () => {
    const base = 'x'.repeat(SLUG_BASE_MAX_LENGTH);
    for (const n of [1, 2, 9, 10, 999_999]) {
      expect(isSlugOrSuffixed(withSuffix(base, n), base)).toBe(true);
    }
  });
});

describe('firstFreeSlug', () => {
  it('returns the base when it is free', () => {
    expect(firstFreeSlug('dune', [])).toBe('dune');
    expect(firstFreeSlug('dune', ['dune-2'])).toBe('dune');
  });

  it('returns the first free suffix', () => {
    expect(firstFreeSlug('dune', ['dune'])).toBe('dune-2');
    expect(firstFreeSlug('dune', new Set(['dune', 'dune-2', 'dune-4']))).toBe('dune-3');
  });

  it('accounts for base shortening on long slugs', () => {
    const base = 'x'.repeat(SLUG_MAX_LENGTH);
    const slug = firstFreeSlug(base, [base, withSuffix(base, 2)]);
    expect(slug).toBe(withSuffix(base, 3));
    expectValidSlug(slug);
  });

  it('throws for an empty base', () => {
    expect(() => firstFreeSlug('', [])).toThrow(TypeError);
  });
});
