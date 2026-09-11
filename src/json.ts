import { visit } from 'jsonc-parser';
import { HttpError, requireThat } from './validation.js';

export function parseJSON(bytes: Uint8Array | string): unknown {
  let text;
  try { text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HttpError('INVALID_JSON', 'JSON must be valid UTF-8.'); }
  const objects: Set<string>[] = []; let depth = 0;
  const begin = () => requireThat(++depth <= 32, 'INVALID_JSON', 'JSON nesting exceeds 32 levels.');
  const string = (value: string) => requireThat(value.isWellFormed(), 'INVALID_JSON', 'Lone Unicode surrogates are forbidden.');
  visit(text, {
    onObjectBegin() { begin(); objects.push(new Set()); },
    onObjectEnd() { objects.pop(); depth--; },
    onArrayBegin() { begin(); }, onArrayEnd() { depth--; },
    onObjectProperty(key) {
      string(key); const keys = objects.at(-1)!;
      requireThat(!keys.has(key), 'INVALID_JSON', 'Duplicate JSON object keys are forbidden.'); keys.add(key);
    },
    onLiteralValue(value) {
      if (typeof value === 'string') string(value);
      if (typeof value === 'number') requireThat(Number.isFinite(value), 'INVALID_JSON', 'Numbers must be finite.');
    },
    onError() { throw new HttpError('INVALID_JSON', 'Malformed JSON.'); },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  return JSON.parse(text);
}
