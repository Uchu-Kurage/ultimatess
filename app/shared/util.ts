import { randomUUID } from 'node:crypto';

/** 安定した一意 ID。DB 主キー等に使用。 */
export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

/** now(ms)。テストで差し替えられるよう関数化。 */
export function now(): number {
  return Date.now();
}

export function assertNever(x: never, msg = 'unexpected variant'): never {
  throw new Error(`${msg}: ${JSON.stringify(x)}`);
}

/** 配列を size ごとに分割。 */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
