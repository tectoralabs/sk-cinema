import { describe, expect, it } from 'vitest';
import { escapeLikePattern } from './likePattern.js';

describe('escapeLikePattern', () => {
  it.each([
    ['%', '\\%'],
    ['_', '\\_'],
    ['\\', '\\\\'],
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['100%_off\\', '100\\%\\_off\\\\'],
    ['%%__\\\\', '\\%\\%\\_\\_\\\\\\\\'],
    ['\\%', '\\\\\\%'],
  ])('escapes %j as %j', (term, expected) => {
    expect(escapeLikePattern(term)).toBe(expected);
  });

  it.each([
    '',
    'Avatar',
    'avatar-fire-and-ash',
    'Mission: Impossible (2023)',
    'ගැහැණු ළමයා',
    '*.?[]^$',
  ])('leaves %j unchanged', (term) => {
    expect(escapeLikePattern(term)).toBe(term);
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeLikePattern('a%b%c_d_e')).toBe('a\\%b\\%c\\_d\\_e');
  });
});
