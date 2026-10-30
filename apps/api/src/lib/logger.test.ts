import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, stream);
  return { logger, output: () => lines.join('') };
}

describe('createLogger', () => {
  it('redacts secrets, tokens and cookies', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: { headers: { cookie: 'session=abc', authorization: 'Bearer xyz' } },
        user: { email: 'a@b.c', password: 'hunter2hunter2', refreshToken: 'rt-secret' },
      },
      'test',
    );

    for (const secret of ['session=abc', 'Bearer xyz', 'hunter2hunter2', 'rt-secret']) {
      expect(output()).not.toContain(secret);
    }
    expect(output()).toContain('a@b.c');
    expect(output()).toContain('[REDACTED]');
  });
});
