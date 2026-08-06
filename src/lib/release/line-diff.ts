export interface UnifiedDiffOptions {
  /** Number of unchanged lines rendered around each change. Defaults to 3. */
  readonly context?: number;
  /** Label rendered on the `---` header line, describing the `-` side. */
  readonly expectedLabel?: string;
  /** Label rendered on the `+++` header line, describing the `+` side. */
  readonly actualLabel?: string;
  /**
   * Safety valve for the O(n*m) LCS table. When the table would exceed this
   * many cells a coarse summary is rendered instead of a full diff, so a
   * pathological input degrades the message rather than the process.
   */
  readonly maxCells?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_CELLS = 4_000_000;

type OpKind = 'equal' | 'del' | 'add';

interface Op {
  readonly kind: OpKind;
  readonly line: string;
}

interface Range {
  start: number;
  end: number;
}

interface SplitFile {
  readonly lines: readonly string[];
  readonly trailingNewline: boolean;
}

/**
 * Splits a file body into lines, recording separately whether the body ended
 * with a newline. `lines` and `trailingNewline` losslessly reconstruct the
 * original string, so a difference living purely in the trailing newline is
 * never silently swallowed — which is exactly the single-appended-byte case the
 * conventions check has to catch.
 */
function splitLines(body: string): SplitFile {
  if (body === '') return { lines: [], trailingNewline: false };
  const parts = body.split('\n');
  if (parts.at(-1) === '') {
    parts.pop();
    return { lines: parts, trailingNewline: true };
  }
  return { lines: parts, trailingNewline: false };
}

function firstDifferingLine(expected: readonly string[], actual: readonly string[]): number {
  const shorter = Math.min(expected.length, actual.length);
  for (let index = 0; index < shorter; index += 1) {
    if (expected[index] !== actual[index]) return index + 1;
  }
  return shorter + 1;
}

function computeOps(expected: readonly string[], actual: readonly string[]): Op[] {
  const rows = expected.length;
  const columns = actual.length;
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        expected[row] === actual[column]
          ? (table[(row + 1) * width + (column + 1)] ?? 0) + 1
          : Math.max(table[(row + 1) * width + column] ?? 0, table[row * width + (column + 1)] ?? 0);
    }
  }

  const ops: Op[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    const left = expected[row] ?? '';
    const right = actual[column] ?? '';
    if (left === right) {
      ops.push({ kind: 'equal', line: left });
      row += 1;
      column += 1;
    } else if ((table[(row + 1) * width + column] ?? 0) >= (table[row * width + (column + 1)] ?? 0)) {
      ops.push({ kind: 'del', line: left });
      row += 1;
    } else {
      ops.push({ kind: 'add', line: right });
      column += 1;
    }
  }
  while (row < rows) {
    ops.push({ kind: 'del', line: expected[row] ?? '' });
    row += 1;
  }
  while (column < columns) {
    ops.push({ kind: 'add', line: actual[column] ?? '' });
    column += 1;
  }
  return ops;
}

function hunkRanges(ops: readonly Op[], context: number): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]?.kind === 'equal') continue;
    let end = index;
    while (end + 1 < ops.length && ops[end + 1]?.kind !== 'equal') end += 1;
    ranges.push({ start: Math.max(0, index - context), end: Math.min(ops.length - 1, end + context) });
    index = end;
  }

  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

function prefixOf(kind: OpKind): string {
  if (kind === 'del') return '-';
  return kind === 'add' ? '+' : ' ';
}

function locate(count: number, lineAt: number | undefined): number {
  const line = lineAt ?? 1;
  return count === 0 ? Math.max(0, line - 1) : line;
}

function renderHunks(ops: readonly Op[], context: number): string[] {
  const expectedLineAt: number[] = [];
  const actualLineAt: number[] = [];
  let expectedLine = 1;
  let actualLine = 1;
  for (const op of ops) {
    expectedLineAt.push(expectedLine);
    actualLineAt.push(actualLine);
    if (op.kind !== 'add') expectedLine += 1;
    if (op.kind !== 'del') actualLine += 1;
  }

  const out: string[] = [];
  for (const range of hunkRanges(ops, context)) {
    let expectedCount = 0;
    let actualCount = 0;
    const body: string[] = [];
    for (const op of ops.slice(range.start, range.end + 1)) {
      if (op.kind !== 'add') expectedCount += 1;
      if (op.kind !== 'del') actualCount += 1;
      body.push(`${prefixOf(op.kind)}${op.line}`);
    }
    // A zero-count side is located at the line it follows, not at 0: an
    // insertion after line 1 is `-1,0`, and only an insertion at the very start
    // of the file is `-0,0`. Reporting 0 unconditionally loses the position.
    const expectedStart = locate(expectedCount, expectedLineAt[range.start]);
    const actualStart = locate(actualCount, actualLineAt[range.start]);
    out.push(`@@ -${expectedStart},${expectedCount} +${actualStart},${actualCount} @@`);
    for (const line of body) out.push(line);
  }
  return out;
}

/**
 * Renders a unified diff of two file bodies.
 *
 * Returns the empty string when the bodies are byte-identical, so the return
 * value doubles as a "they differ" signal. `-` lines come from `expected`,
 * `+` lines come from `actual`.
 */
export function unifiedDiff(expected: string, actual: string, options: UnifiedDiffOptions = {}): string {
  if (expected === actual) return '';

  const context = options.context ?? DEFAULT_CONTEXT;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const expectedLabel = options.expectedLabel ?? 'expected';
  const actualLabel = options.actualLabel ?? 'actual';

  const left = splitLines(expected);
  const right = splitLines(actual);
  const header = [`--- ${expectedLabel}`, `+++ ${actualLabel}`];

  if ((left.lines.length + 1) * (right.lines.length + 1) > maxCells) {
    const at = firstDifferingLine(left.lines, right.lines);
    return [
      ...header,
      `(too large to diff: ${left.lines.length} expected lines vs ${right.lines.length} actual lines; first difference at line ${at})`,
    ].join('\n');
  }

  const body = renderHunks(computeOps(left.lines, right.lines), context);

  const notes: string[] = [];
  if (left.trailingNewline !== right.trailingNewline) {
    notes.push(
      left.trailingNewline
        ? `\\ ${actualLabel} has no newline at end of file`
        : `\\ ${expectedLabel} has no newline at end of file`,
    );
  }

  // An empty body means every line matched; combined with the byte-inequality
  // established above, the only remaining difference is the trailing newline.
  if (body.length === 0) body.push('(lines are identical; only the trailing newline differs)');

  return [...header, ...body, ...notes].join('\n');
}
