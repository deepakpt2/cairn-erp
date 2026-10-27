import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The assignment editor on /config/settlement-configuration keeps its four fields in one state object and
 * updates it through `setAssignment(updater)`. React does not run that updater while the change handler is
 * still on the stack: it runs it later, and by then the synthetic event has been released, so
 * `event.currentTarget` is null. A handler that reaches for `event.currentTarget` *inside* the updater
 * therefore throws inside React's reducer, the page tears down with
 * "Application error: a client-side exception has occurred", and the assignment is never saved.
 *
 * These cases do not assert on wording. They lift the onChange expressions out of the component exactly as
 * they are written, build functions from them, and drive them through React's own event lifecycle — including
 * the double-invocation of updaters a development build performs — and require the typed value to arrive in
 * state. Only a handler that reads the event synchronously survives that.
 */

const COMPONENT = 'src/app/config/settlement-configuration/SettlementMasters.tsx';
const source = readFileSync(COMPONENT, 'utf8');
const lines = source.split('\n');

/** The fields whose change handlers feed the shared `assignment` state object. */
const FIELDS = ['sourceAccount', 'receiverCategory', 'settlementAccount'] as const;

type Assignment = {
  sourceAccount: string;
  receiverCategory: string;
  byOriginalAccount: boolean;
  settlementAccount: string;
};

const EMPTY: Assignment = {
  sourceAccount: '',
  receiverCategory: 'COST_CENTER',
  byOriginalAccount: true,
  settlementAccount: '',
};

type FakeEvent = { target: { value: string }; readonly currentTarget: { value: string } | null };

/**
 * React's contract, in one object: the element is reachable through `currentTarget` while the handler runs
 * and is nulled the moment the handler returns — before any queued updater executes.
 */
function reactLikeEvent(value: string): { event: FakeEvent; release: () => void } {
  let released = false;
  const target = { value };
  return {
    event: {
      target,
      get currentTarget() {
        return released ? null : target;
      },
    },
    release: () => {
      released = true;
    },
  };
}

/**
 * The text inside `onChange={ … }`, whether it is written on one line or ten. Braces are counted and quoted
 * spans are skipped, so the extraction cannot quietly return nothing when the component is reflowed.
 */
function extractExpression(startLine: number, marker: string): { expr: string; line: number } {
  let i = startLine;
  let head = '';
  while (i < lines.length) {
    const at = lines[i].indexOf(marker);
    if (at >= 0) {
      head = lines[i].slice(at + marker.length);
      break;
    }
    i += 1;
  }
  if (!head) throw new Error(`${marker} not found from line ${startLine + 1} — the component moved, fix this test`);
  const foundAt = i;
  let depth = 1; // inside the brace the marker opened
  let out = '';
  let quote: string | null = null;
  for (; i < lines.length; i += 1) {
    const line = i === foundAt ? head : lines[i];
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (quote) {
        out += ch;
        if (ch === quote && line[c - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') {
        depth += 1;
        out += ch;
        continue;
      }
      if (ch === '}' || ch === ')' || ch === ']') {
        depth -= 1;
        if (depth === 0) return { expr: out.trim(), line: foundAt + 1 };
        out += ch;
        continue;
      }
      out += ch;
    }
    out += '\n';
  }
  throw new Error(`unbalanced ${marker} opened on line ${foundAt + 1}`);
}

/** Build the field's change handler as a callable, from the component's own text. */
function handlerFor(field: (typeof FIELDS)[number]) {
  const at = lines.findIndex((line) => line.trim() === `name="${field}"`);
  if (at < 0) throw new Error(`${field}: no such field in ${COMPONENT} — the component moved, fix this test`);
  let onChangeAt = -1;
  for (let i = at; i < Math.min(at + 14, lines.length); i += 1) {
    if (lines[i].includes('onChange={')) {
      onChangeAt = i;
      break;
    }
  }
  if (onChangeAt < 0) throw new Error(`${field}: no onChange within 14 lines of the field tag`);
  const { expr, line } = extractExpression(onChangeAt, 'onChange={');
  if (!expr.startsWith('(event)')) throw new Error(`${field}: unexpected handler shape ${expr.slice(0, 48)}`);
  // eslint-disable-next-line no-new-func -- executing the shipped expression is the point; a text check would not fail.
  const build = new Function('setAssignment', `return ${expr};`) as (
    setAssignment: (updater: (state: Assignment) => Assignment) => void,
  ) => (event: FakeEvent) => void;
  return { field, expr, line, build };
}

/** Every onChange expression on the screen, with the line it starts on. */
function allChangeHandlers(): Array<{ expr: string; line: number }> {
  const out: Array<{ expr: string; line: number }> = [];
  lines.forEach((line, i) => {
    if (line.includes('onChange={')) out.push(extractExpression(i, 'onChange={'));
  });
  return out;
}

/**
 * Run one change the way the browser does: the handler is called with a live event, React releases the event,
 * and only then are the queued updaters applied — twice, because a development build asks them to be pure.
 */
function applyChange(handler: ReturnType<typeof handlerFor>, typed: string): Assignment {
  const queued: Array<(state: Assignment) => Assignment> = [];
  const { event, release } = reactLikeEvent(typed);
  handler.build((updater) => {
    queued.push(updater);
  })(event);
  release();
  expect(queued.length, `${handler.field}: expected one queued updater`).toBe(1);
  const first = queued[0]!(EMPTY);
  expect(queued[0]!(EMPTY), `${handler.field}: updater is not pure across double invocation`).toEqual(first);
  return first;
}

describe('settlement assignment editor — change handlers against React’s event lifecycle', () => {
  const handlers = new Map(FIELDS.map((field) => [field, handlerFor(field)]));

  it('finds all three handlers, so a silent miss cannot read as success', () => {
    expect(handlers.size).toBe(3);
    for (const field of FIELDS) {
      expect(handlers.get(field)!.expr, `${field} handler shape`).toContain('setAssignment');
    }
    const text = [...handlers.values()].map((h) => h.expr).join('\n');
    for (const field of FIELDS) expect(text, `extraction lost ${field}`).toContain(field);
    expect(allChangeHandlers().length, 'the screen has change handlers this scan cannot see').toBeGreaterThanOrEqual(8);
  });

  it('carries the typed value into state after React has released the event', () => {
    const cases: Array<[typeof FIELDS[number], string, string]> = [
      ['sourceAccount', '600abc', '600ABC'], // the field upper-cases what was typed
      ['receiverCategory', 'INTERNAL_ORDER', 'INTERNAL_ORDER'],
      ['settlementAccount', '999zz', '999ZZ'],
    ];
    for (const [field, typed, expected] of cases) {
      const handler = handlers.get(field)!;
      const after = applyChange(handler, typed);
      expect(after[field], `${field} (component line ${handler.line})`).toBe(expected);
      for (const other of Object.keys(EMPTY) as Array<keyof Assignment>) {
        if (other !== field) expect(after[other], `${field} clobbered ${other}`).toBe(EMPTY[other]);
      }
    }
  });

  it('leaves no change handler on this screen reading the event from inside an updater', () => {
    // Shape guard, deliberately over the whole screen: it stops the same mistake arriving on another field,
    // where the behavioural cases above would not be looking. A *synchronous* read of the event —
    // `onChange={(event) => setNewCode(event.currentTarget.value)}` — is legal and stays untouched; what is
    // illegal is a read that happens after an updater arrow has been handed to a setter.
    const offending = allChangeHandlers()
      .filter(({ expr }) => {
        const updater = expr.match(/set\w+\(\(\w+\) =>/);
        return updater && expr.slice((updater.index ?? 0) + updater[0].length).includes('event.currentTarget');
      })
      .map(({ line, expr }) => `line ${line}: ${expr.replace(/\s+/g, ' ').slice(0, 70)}`);
    expect(offending).toEqual([]);
  });
});
