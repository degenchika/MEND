// mend — one patch tool for every AI edit format.
//
// Applies a patch in one of four formats to the tree of text files rooted
// at the current working directory:
//   * unified diff        (diff --git / --- + +++ sections with @@ hunks)
//   * SEARCH/REPLACE blocks (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE)
//   * V4A patches          (*** Begin Patch ... *** End Patch)
//   * JSON edits           (a JSON array or one edit object per line)
// Every edit names the lines it changes; they are found at the first of
// three matching tiers that has an occurrence: exact, then trailing
// whitespace stripped, then leading and trailing whitespace stripped.
// --strict forces tier 0 (exact) only.
//
// All edits apply in patch order to the tree as earlier edits left it.
// If any edit fails, no file is written at all (exit 1); otherwise every
// change is written (exit 0). Malformed patches fail before any file is
// looked at (exit 2). See SPEC.md, which is the whole contract.
//
// Node 22, standard library only, no network, deterministic.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   --format=NAME  one of auto, unified, search-replace, v4a, json
//                  (default auto; detects v4a, then json, then
//                  search-replace, then unified)
//   --check        print what would change, write nothing
//   --strict       tier 0 (exact) matching only
//   PATCH          patch file, or stdin when absent or '-'
// When MAKEFUN_ENV_URL is set, this file hands over to runner.ts, which
// runs the trial: it fetches the checks, runs this CLI on each one in a
// fresh directory, and posts the results back.

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type Format = (typeof FORMATS)[number];

class Exit2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Exit2';
  }
}

class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.name = 'Fail';
    this.code = code;
    this.path = path;
  }
}

type Edit = (tree: Tree) => void;

function blank(line: string): boolean {
  return line.trim() === '';
}

// Split patch text at \n; one trailing \r is removed from each line; no
// empty piece is left after a final \n.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A path is safe when it is non-empty, has no leading /, no backslash, and
// no segment that is empty, '.' or '..'.
function safe(path: string): boolean {
  if (path === '') return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

interface FileSplit {
  lines: string[];
  br: string;
  final: boolean;
}

// A file's line break is CRLF when its first line feed follows a carriage
// return, and LF otherwise; its lines are the text split at that break.
// The file ends with a break exactly when its text ends with one; the last
// empty piece after a final break is not a line; an empty file has no
// lines and no final break.
function splitFile(text: string): FileSplit {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.trim();
}

// The working tree: `orig` is what the files held before any edit (read
// lazily from disk), `now` is what edits have done to them (null = deleted).
// Nothing is written to disk until every edit has succeeded.
class Tree {
  private origCache = new Map<string, string | null>();
  private diskCache = new Map<string, boolean>();
  now = new Map<string, string | null>();
  moves: { old: string; nw: string }[] = [];

  diskExists(p: string): boolean {
    if (!this.diskCache.has(p)) {
      try {
        statSync(p);
        this.diskCache.set(p, true);
      } catch {
        this.diskCache.set(p, false);
      }
    }
    return this.diskCache.get(p)!;
  }

  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p)!;
  }

  // True when the path exists right now: as an edited file, or on disk
  // (file or directory).
  existsNow(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    return this.diskExists(p);
  }

  // Current contents, or null when the file does not exist right now
  // (a directory counts as missing).
  readNow(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p)!;
    return this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

// All occurrences of O in lines, positions may overlap.
function occurrences(lines: string[], O: string[], tier: number): number[] {
  if (O.length === 0) return [];
  const nO = O.map((l) => normLine(l, tier));
  const out: number[] = [];
  outer: for (let i = 0; i + O.length <= lines.length; i++) {
    for (let k = 0; k < O.length; k++) {
      if (normLine(lines[i + k]!, tier) !== nO[k]!) continue outer;
    }
    out.push(i);
  }
  return out;
}

// The first tier (0, 1, 2 — or only 0 when strict) with at least one
// occurrence, with all of its positions.
function findTier(
  lines: string[],
  O: string[],
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

// As findTier, but only occurrences at or after `from`.
function findTierFrom(
  lines: string[],
  O: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

// Build the replacement lines for a matched O at position pos. Context
// lines are written as the file's own matched lines, never the patch's.
// At tier 2, every non-context new line is re-indented: the leading
// whitespace of the file's first matched line replaces the leading
// whitespace of O's first line.
function buildNew(
  O: string[],
  N: string[],
  ctx: number[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2) {
    F = leadingWs(fileLines[pos] ?? '');
    P = leadingWs(O[0] ?? '');
  }
  for (let k = 0; k < N.length; k++) {
    const oi = ctx[k];
    if (oi !== undefined && oi >= 0) {
      out.push(fileLines[pos + oi]!);
      continue;
    }
    let line = N[k]!;
    if (
      tier === 2 &&
      line !== '' &&
      line.trim() !== '' &&
      line.startsWith(P)
    ) {
      line = F + line.slice(P.length);
    }
    out.push(line);
  }
  return out;
}

// Split a chunk body (unified hunk or V4A chunk) into its old lines O, its
// new lines N, and a per-new-line map to the O index when the line is a
// context line (-1 otherwise). A backslash line is a marker for the line
// before it, not a line of its own.
function chunkParts(body: string[]): {
  O: string[];
  N: string[];
  ctx: number[];
  backslashAfterLast: boolean;
} {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: number[] = [];
  let oIdx = 0;
  let lastCp = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') {
      O.push('');
      N.push('');
      ctx.push(oIdx);
      oIdx++;
      lastCp = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      O.push(t);
      N.push(t);
      ctx.push(oIdx);
      oIdx++;
      lastCp = k;
    } else if (l[0] === '-') {
      O.push(l.slice(1));
      oIdx++;
    } else if (l[0] === '+') {
      N.push(l.slice(1));
      ctx.push(-1);
      lastCp = k;
    }
    // '\' lines are markers, not part of O or N.
  }
  const backslashAfterLast =
    lastCp >= 0 &&
    body[lastCp + 1] !== undefined &&
    body[lastCp + 1]![0] === '\\';
  return { O, N, ctx, backslashAfterLast };
}

// First line at or after `cursor` equal to the anchor, at the first tier
// with one; -1 when there is none.
function findAnchor(
  lines: string[],
  anchor: string,
  cursor: number,
  strict: boolean,
): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = normLine(anchor, t);
    for (let i = cursor; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === a) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): Format | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) {
    return 'search-replace';
  }
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') &&
          (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.existsNow(p)) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.readNow(p);
      if (before === null) throw new Fail('missing', p);
      // In a CRLF file the file text and both strings are read with every
      // \r\n as \n, and the result is written back with \r\n.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string =>
        crlf ? s.replaceAll('\r\n', '\n') : s;
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count++;
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.readNow(p);
      if (before === null) throw new Fail('missing', p);
      const { lines, br, final } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.set(p, joinFile(lines, br, final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  // One JSON array: any fault is a parse error at the line where the
  // array starts.
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines: one edit object per line, blank lines ignored; a line not
  // holding one valid edit object is a parse error at that line.
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface UniHunk {
  A: number;
  body: string[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

// The path of a --- or +++ header line: the text after 4 characters, up
// to the first tab, with surrounding spaces removed; /dev/null is no file.
function headerPath(line: string): string | null {
  const raw = line.slice(4);
  const upToTab = raw.split('\t')[0]!;
  const p = upToTab.trim();
  if (p === '/dev/null') return null;
  return stripAB(p);
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return parseInt(m[1]!, 10);
}

function parseHunkBody(
  lines: string[],
  start: number,
): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (
      l.startsWith('--- ') &&
      (lines[i + 1] ?? '').startsWith('+++ ')
    ) {
      break;
    }
    if (l.startsWith('diff --git ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function applyHunks(
  before: string,
  hunks: UniHunk[],
  strict: boolean,
  path: string,
): string {
  let { lines, br, final } = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N, ctx, backslashAfterLast } = chunkParts(h.body);
    if (O.length > 0) {
      const found = findTier(lines, O, strict);
      if (!found) throw new Fail('no-match', path);
      // The occurrence whose position is nearest to A-1+d; ties go to the
      // earlier one.
      const target = h.A - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const repl = buildNew(O, N, ctx, lines, best, found.tier);
      const toEnd = best + O.length === lines.length;
      lines = [
        ...lines.slice(0, best),
        ...repl,
        ...lines.slice(best + O.length),
      ];
      // When a hunk's matched lines run to the end of the file, the
      // result ends with a line break unless a \ line follows the hunk's
      // last context or + line.
      if (toEnd) final = !backslashAfterLast;
      d += N.length - O.length;
    } else {
      // Empty O: the new lines are inserted after the first A+d lines
      // (all of them when the file has fewer).
      const idx = Math.max(0, Math.min(h.A + d, lines.length));
      const atEnd = idx === lines.length;
      lines = [...lines.slice(0, idx), ...N, ...lines.slice(idx)];
      if (atEnd) final = !backslashAfterLast;
      d += N.length;
    }
  }
  return joinFile(lines, br, final);
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    // Creation: the old path is /dev/null, or a `new file mode` line.
    if (sec.newFile || oldP === null) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.existsNow(newP)) throw new Fail('exists', newP);
      // The file is the + lines of all its hunks, in order.
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const l = h.body[k]!;
          if (l[0] === '+') {
            plus.push(l.slice(1));
            lastPlusBackslash =
              h.body[k + 1] !== undefined && h.body[k + 1]![0] === '\\';
          }
        }
      }
      // A created file ends with a line break unless a \ line follows
      // its last + line.
      const text =
        plus.length === 0
          ? ''
          : plus.join('\n') + (lastPlusBackslash ? '' : '\n');
      tree.set(newP, text);
      return;
    }
    // Deletion: the new path is /dev/null, or a `deleted file mode` line.
    if (sec.deletedFile || newP === null) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.readNow(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    // Move: the two paths differ.
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.readNow(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.existsNow(newP)) throw new Fail('exists', newP);
      const text = applyHunks(before, sec.hunks, strict, oldP);
      tree.set(oldP, null);
      tree.set(newP, text);
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    // Otherwise a change.
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.readNow(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let seenPair = false;
  let seenHunk = false;
  const newSection = (
    oldPath: string | null,
    newPath: string | null,
  ): UniSection => {
    const s: UniSection = {
      oldPath,
      newPath,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A section starts at `diff --git a/<X> b/<Y>`.
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(stripAB(m[1]!), stripAB(m[2]!));
      seenPair = false;
      seenHunk = false;
      i++;
      continue;
    }
    // A section also starts at a --- line followed by a +++ line.
    if (
      line.startsWith('--- ') &&
      (lines[i + 1] ?? '').startsWith('+++ ')
    ) {
      if (cur !== null && !seenHunk && !seenPair) {
        // The pair belongs to the current section's header.
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        seenPair = true;
        i += 2;
        continue;
      }
      cur = newSection(headerPath(line), headerPath(lines[i + 1]!));
      seenPair = true;
      seenHunk = false;
      i += 2;
      continue;
    }
    if (cur === null) {
      // A hunk before any section is a parse error; anything else outside
      // a section is ignored (prose, code fences).
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (!seenHunk) {
      // A --- line not followed by a +++ line inside a section's header
      // is a parse error at the line after it.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (!seenPair) cur.oldPath = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!seenPair) cur.newPath = line.slice(10).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (
        line === 'deleted file mode' ||
        line.startsWith('deleted file mode ')
      ) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const A = parseHunkHeader(line);
        if (A === null) throw new Exit2(`error: parse ${i + 1}`);
        const r = parseHunkBody(lines, i + 1);
        cur.hunks.push({ A, body: r.body });
        seenHunk = true;
        i = r.next;
        continue;
      }
      i++;
      continue;
    }
    // After the first hunk, only @@ starts a new hunk; everything else
    // is ignored.
    if (line.startsWith('@@')) {
      const A = parseHunkHeader(line);
      if (A === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunkBody(lines, i + 1);
      cur.hunks.push({ A, body: r.body });
      i = r.next;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, after the
    // previous block's REPLACE line (or the start of the patch), not
    // blank and (trimmed) not starting with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // The old lines run to the ======= line; the new lines run to the
    // >>>>>>> REPLACE line.
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const O = lines.slice(i + 1, eq);
    const N = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      // Empty old lines create the file.
      if (O.length === 0) {
        if (tree.existsNow(p)) throw new Fail('exists', p);
        tree.set(p, N.length === 0 ? '' : N.join('\n') + '\n');
        return;
      }
      const before = tree.readNow(p);
      if (before === null) throw new Fail('missing', p);
      const { lines: fileLines, br, final } = splitFile(before);
      const found = findTier(fileLines, O, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repl = buildNew(
        O,
        N,
        O.map(() => -1),
        fileLines,
        pos,
        found.tier,
      );
      fileLines.splice(pos, O.length, ...repl);
      tree.set(p, joinFile(fileLines, br, final));
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aAdd(path: string, body: { n: number; t: string }[]): Edit {
  const fileLines: string[] = [];
  for (const { n, t } of body) {
    if (t.startsWith('+')) fileLines.push(t.slice(1));
    else if (t === '') fileLines.push('');
    else throw new Exit2(`error: parse ${n}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.existsNow(path)) throw new Fail('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string, body: { n: number; t: string }[]): Edit {
  for (const { n, t } of body) {
    if (!blank(t)) throw new Exit2(`error: parse ${n}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.readNow(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdate(
  path: string,
  body: { n: number; t: string }[],
  startLine: number,
  strict: boolean,
): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && /^\*\*\* Move to: /.test(body[0]!.t)) {
    moveTo = body[0]!.t.replace(/^\*\*\* Move to: /, '').trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let started = false;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; k < body.length; k++) {
    const { n, t } = body[k]!;
    if (t.startsWith('@@')) {
      closeChunk();
      const anchorText = t.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      started = true;
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) {
        chunks.push({ anchor: null, eof: true, body: [] });
      } else {
        cur.eof = true;
        chunks.push(cur);
        cur = null;
      }
      started = true;
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${n}`);
        cur = { anchor: null, eof: false, body: [] };
        started = true;
      }
      cur.body.push(t);
      continue;
    }
    throw new Exit2(`error: parse ${n}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) {
    throw new Exit2(`error: parse ${startLine}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.readNow(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.existsNow(moveTo)) {
      throw new Fail('exists', moveTo);
    }
    let { lines, br, final } = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const pos = findAnchor(lines, ch.anchor, cursor, strict);
        if (pos < 0) throw new Fail('no-match', path);
        cursor = pos + 1;
      }
      const { O, N, ctx } = chunkParts(ch.body);
      if (O.length > 0) {
        const found = findTierFrom(lines, O, cursor, strict);
        if (!found) throw new Fail('no-match', path);
        let pos = found.positions[0]!;
        if (ch.eof) {
          // An End of File chunk takes only an occurrence ending at the
          // file's last line.
          const ok = found.positions.filter(
            (p) => p + O.length === lines.length,
          );
          if (ok.length === 0) throw new Fail('no-match', path);
          pos = ok[0]!;
        }
        const repl = buildNew(O, N, ctx, lines, pos, found.tier);
        lines = [
          ...lines.slice(0, pos),
          ...repl,
          ...lines.slice(pos + O.length),
        ];
        cursor = pos + repl.length;
      } else {
        // Empty O: the new lines are inserted at the cursor (at the end
        // of the file for an End of File chunk).
        const idx = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, idx), ...N, ...lines.slice(idx)];
        cursor = idx + N.length;
      }
    }
    const text = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, text);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(lines[i]!);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const startLine = i + 1;
    // The section's body runs to the next section or to the End Patch
    // line; blank lines at its end are not part of it.
    const body: { n: number; t: string }[] = [];
    let j = i + 1;
    while (j < last) {
      if (/^\*\*\* (Add|Delete|Update) File: /.test(lines[j]!)) break;
      body.push({ n: j + 1, t: lines[j]! });
      j++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.t)) body.pop();
    if (kind === 'Add') edits.push(v4aAdd(path, body));
    else if (kind === 'Delete') edits.push(v4aDelete(path, body));
    else edits.push(v4aUpdate(path, body, startLine, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// The CLI (SPEC sections 1-3, 10)
// ---------------------------------------------------------------------------

function parsePatch(
  kind: Format,
  text: string,
  lines: string[],
  strict: boolean,
): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines, strict);
}

interface RunResult {
  code: number;
  out: string;
}

function run(args: string[]): RunResult {
  let format: Format = 'auto';
  let check = false;
  let strict = false;
  let positional: string | null = null;
  let seenEndOptions = false;
  for (const a of args) {
    if (seenEndOptions) {
      if (positional !== null) return { code: 2, out: 'error: usage\n' };
      positional = a;
      continue;
    }
    if (a === '--') {
      seenEndOptions = true;
      continue;
    }
    if (a === '--check') {
      if (check) return { code: 2, out: 'error: usage\n' };
      check = true;
      continue;
    }
    if (a === '--strict') {
      if (strict) return { code: 2, out: 'error: usage\n' };
      strict = true;
      continue;
    }
    if (a.startsWith('--format=')) {
      const v = a.slice(9);
      if (format !== 'auto') return { code: 2, out: 'error: usage\n' };
      if (!(FORMATS as readonly string[]).includes(v)) {
        return { code: 2, out: 'error: usage\n' };
      }
      format = v as Format;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      return { code: 2, out: 'error: usage\n' };
    }
    if (positional !== null) return { code: 2, out: 'error: usage\n' };
    positional = a;
  }

  // The patch comes from a file, or from stdin when absent or '-'.
  let text: string;
  if (positional === null || positional === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(positional, 'utf8');
    } catch {
      return { code: 2, out: 'error: no-patch\n' };
    }
  }

  const lines = patchLines(text);
  const kind = format === 'auto' ? detect(lines) : format;
  let edits: Edit[];
  try {
    if (kind === null) throw new Exit2('error: format');
    edits = parsePatch(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: `${e.message}\n` };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: 'error: parse 1\n' };

  // Every edit applies in patch order to the tree as earlier edits left
  // it. A failed edit changes nothing, and the edits after it still run,
  // so every failure is reported. When any edit failed, no file is
  // written.
  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const snapshotMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof Fail) {
        tree.now = snapshot;
        tree.moves.length = snapshotMoves;
        failures.push({ code: e.code, path: e.path });
        continue;
      }
      throw e;
    }
  }
  if (failures.length > 0) {
    const out: string[] = failures.map(
      (f) => `error: ${f.code} ${f.path}`,
    );
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out: out.join('\n') + '\n' };
  }

  // One row per changed path, in UTF-8 byte order; a move is one R row
  // (by its new path) instead of its D and A rows. An unchanged-bytes
  // file is not listed, and a no-change patch prints only the ok line.
  const rows: { key: string; line: string }[] = [];
  const accounted = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.has(mv.old)
      ? tree.now.get(mv.old)!
      : undefined;
    const wasNew = tree.original(mv.nw);
    const nowNew = tree.now.has(mv.nw) ? tree.now.get(mv.nw)! : undefined;
    if (
      wasOld !== null &&
      nowOld === null &&
      wasNew === null &&
      nowNew !== null &&
      nowNew !== undefined
    ) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      accounted.add(mv.old);
      accounted.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (accounted.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const line =
      was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}`;
    rows.push({ key: p, line });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  outLines.push(
    `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`,
  );

  if (!check) {
    // Deletions first, then writes, so a move into its own directory
    // still works.
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: outLines.join('\n') + '\n' };
}

// ---------------------------------------------------------------------------
// Hand-over: with MAKEFUN_ENV_URL set, this is the trial runner.
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  const { code, out } = run(process.argv.slice(2));
  process.stdout.write(out);
  process.exitCode = code;
}
