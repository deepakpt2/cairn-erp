import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A `use server` file may export async functions and nothing else.
 *
 * Next enforces that when a server action is *called*, not when the app is built: a screen whose actions
 * module also exports an object renders, links, reads and passes every service test — and throws a
 * server-side exception the moment somebody submits one of its forms. `next dev` never reaches the check, so
 * a screen can be developed, reviewed and merged with every form on it broken. The employee record-type
 * screen of `9193` shipped exactly that way (`export { EMPTY }` beside its actions) and only the browser run
 * for it, which is the only kind of run that submits anything, found the fault.
 *
 * Type exports are erased before runtime and stay allowed: a form needs its state shape named somewhere the
 * page and the action both read.
 */
function actionsFiles(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) actionsFiles(path, found);
    else if (entry === 'actions.ts' || entry === 'actions.tsx') found.push(path);
  }
  return found;
}

/**
 * What a `use server` module may put on its exports: async function declarations, the types its forms share,
 * and — because the check Next runs is on the *value*, not on the syntax — a binding produced by a call or an
 * arrow, which is how several screens wrap a session guard around each action (`export const saveThingAction =
 * handler(async (form, actor) => …)`). A plain object, an array, a literal, a re-export list or a synchronous
 * function is what makes the module throw when a form is submitted.
 */
const ALLOWED = /^export\s+(?:async\s+function|type\b|interface\b)/;
const FUNCTION_VALUED = /^export\s+(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\b|function\b|[A-Za-z_$][\w$.]*\s*\(|[A-Za-z_$][\w$]*\s*=>)/;

function offenders(source: string): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter(({ text }) => text.startsWith('export ') && !ALLOWED.test(text) && !FUNCTION_VALUED.test(text))
    .map(({ text, line }) => `${line}: ${text}`);
}

describe("'use server' modules export only async functions", () => {
  const files = actionsFiles('src/app');

  it('reads the actions modules of the app routes', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files.map((file) => [file] as const))('%s', (file) => {
    const source = readFileSync(file, 'utf8');
    if (!/^['"]use server['"];?/m.test(source)) return;
    expect(offenders(source), `${file} exports values a server-action module may not carry`).toEqual([]);
  });

  it('catches the shape that broke 9193, and the equivalents', () => {
    expect(offenders("export { EMPTY };")).toHaveLength(1);
    expect(offenders("export const EMPTY = { ok: false };")).toHaveLength(1);
    expect(offenders("export function helper() {}")).toHaveLength(1);
    expect(offenders("export default handler;")).toHaveLength(1);
    expect(offenders("export interface State { ok: boolean }")).toHaveLength(0);
    expect(offenders("export type State = { ok: boolean };")).toHaveLength(0);
    expect(offenders("export async function saveAction() {}")).toHaveLength(0);
    expect(offenders("export const saveAction = handler(async (form, actor) => {});")).toHaveLength(0);
    expect(offenders("export const saveAction = async (form: FormData) => {};")).toHaveLength(0);
    expect(offenders("export const EMPTY: State = { ok: false };")).toHaveLength(1);
    expect(offenders("export const ROUTES = ['/a', '/b'];")).toHaveLength(1);
  });
});
