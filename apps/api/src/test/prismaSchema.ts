import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * A minimal schema.prisma reader for the unique-field guard tests (isMovieSlugClash,
 * isScreenNameClash). Prisma 7's `prisma-client` generator exposes no runtime schema metadata
 * with uniqueness (no `Prisma.dmmf`; the generated `runtimeDataModel` lists only field names,
 * kinds and types), so the guards read the source of truth and cross-check the reader against
 * the generated client (field list at runtime, unique inputs at compile time).
 */

const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

/** The text of apps/api/prisma/schema.prisma. */
export function readSchemaPrisma(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

/** Removes a `//` (or `///`) comment, ignoring `//` inside a double-quoted string. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && inString) i += 1;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Replaces double-quoted strings with "", so text inside them is never read as an attribute. */
const blankStrings = (line: string) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""');

export interface ModelUniqueness {
  /** Every field name, in declaration order (scalar and relation fields). */
  fields: string[];
  /** Fields with a field-level `@id`. */
  idFields: string[];
  /** Fields with a field-level `@unique`. */
  uniqueFields: string[];
  /** Block-level `@@id(...)` and `@@unique(...)` attributes, as written. */
  blockAttributes: string[];
}

/**
 * Reads one `model X { ... }` block of schema.prisma. Deliberately minimal: one field or block
 * attribute per line (what `prisma format` produces), comments and string contents ignored.
 * Throws if the block is missing or unterminated rather than guessing.
 */
export function readModelUniqueness(schema: string, model: string): ModelUniqueness {
  const lines = schema.split(/\r?\n/).map((line) => blankStrings(stripComment(line)).trim());
  const start = lines.findIndex((line) => new RegExp(`^model\\s+${model}\\s*\\{$`).test(line));
  if (start === -1) throw new Error(`schema.prisma: model ${model} not found`);
  const length = lines.slice(start + 1).findIndex((line) => line === '}');
  if (length === -1) throw new Error(`schema.prisma: model ${model} is not closed`);

  const result: ModelUniqueness = {
    fields: [],
    idFields: [],
    uniqueFields: [],
    blockAttributes: [],
  };
  for (const line of lines.slice(start + 1, start + 1 + length)) {
    if (line === '') continue;
    if (line.startsWith('@@')) {
      if (/^@@(id|unique)\b/.test(line)) result.blockAttributes.push(line);
      continue;
    }
    const [name = '', , ...attributes] = line.split(/\s+/);
    result.fields.push(name);
    const attrs = attributes.join(' ');
    if (/(^|\s)@id\b/.test(attrs)) result.idFields.push(name);
    if (/(^|\s)@unique\b/.test(attrs)) result.uniqueFields.push(name);
  }
  return result;
}
