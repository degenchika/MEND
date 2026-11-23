// mend — one patch tool for every AI edit format.
//
// A patch comes in one of four shapes — a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON edit objects — and mend applies it to the
// tree of text files rooted at the working directory. An edit names the
// lines it replaces; they are looked up at the first of three matching
// tiers that finds them: exactly, then with trailing whitespace ignored,
// then with leading and trailing whitespace ignored. --strict keeps only
// the exact tier.
//
// Edits run in patch order against the tree as earlier edits left it. When
// any edit fails, nothing is written at all; when every edit succeeds, all
// of the changes are written. A patch that cannot even be read fails before
// any file is looked at. SPEC.md is the contract; this file follows it.
//
// Node 22, standard library only, no network, deterministic.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   --format=NAME  auto, unified, search-replace, v4a or json (default auto)
//   --check        report what would change, write nothing
//   --strict       exact matching only
//   PATCH          patch file, or stdin when missing or '-'
// With MAKEFUN_ENV_URL set, control passes to runner.ts, which runs a trial.

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type PatchFormat = (typeof KNOWN_FORMATS)[number];

// A patch that cannot be read: the message is already the stdout line
// ("error: parse <N>", "error: format"), exit 2.
class ParseFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseFailure';
  }
}

// One edit that could not be applied: its code and the path it concerns.
class EditFailure extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.name = 'EditFailure';
    this.code = code;
    this.path = path;
  }
}

// One parsed edit, applied to the working tree in memory.
type Applier = (ws: Workspace) => void;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

// A patch's lines: split at \n, one trailing \r stripped from each, and
// no empty piece left after a final \n.
function splitPatchText(text: string): string[] {
  if (text === '') return [];
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows.map((row) => (row.endsWith('\r') ? row.slice(0, -1) : row));
}

// A path is safe when it is non-empty, has no leading /, holds no
// backslash, and none of its /-separated pieces is empty, '.' or '..'.
function isSafePath(path: string): boolean {
  if (path === '') return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  for (const piece of path.split('/')) {
    if (piece === '' || piece === '.' || piece === '..') return false;
  }
  return true;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

interface TextLines {
  rows: string[];
  eol: string;
  terminated: boolean;
}

// How a file's text breaks into lines: CRLF when its first line feed
// follows a carriage return, LF otherwise. The file is terminated exactly
// when its text ends with its break; the empty piece after a final break
// is not a line. An empty file has no lines and is not terminated.
function splitText(text: string): TextLines {
  if (text === '') return { rows: [], eol: '\n', terminated: false };
  const firstFeed = text.indexOf('\n');
  const eol =
    firstFeed > 0 && text[firstFeed - 1] === '\r' ? '\r\n' : '\n';
  const rows = text.split(eol);
  const terminated = text.endsWith(eol);
  if (terminated) rows.pop();
  return { rows, eol, terminated };
}

function joinText(rows: string[], eol: string, terminated: boolean): string {
  if (rows.length === 0) return '';
  return rows.join(eol) + (terminated ? eol : '');
}

function indentPrefix(s: string): string {
  const found = /^[ \t]*/.exec(s);
  return found ? found[0] : '';
}

// The form of a line at a matching tier: itself, with trailing spaces and
// tabs removed, or trimmed on both sides.
function keyOf(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.trim();
}

// The working tree, kept in memory until every edit has succeeded.
// `beforeCache` holds what the files held before any edit (read lazily),
// `pending` holds what edits have done to them (null = deleted), and
// `renames` records the moves, in order. Nothing touches the disk until
// the end.
class Workspace {
  private beforeCache = new Map<string, string | null>();
  private diskSeen = new Map<string, boolean>();
  pending = new Map<string, string | null>();
  renames: { from: string; to: string }[] = [];

  existsOnDisk(p: string): boolean {
    if (!this.diskSeen.has(p)) {
      try {
        statSync(p);
        this.diskSeen.set(p, true);
      } catch {
        this.diskSeen.set(p, false);
      }
    }
    return this.diskSeen.get(p)!;
  }

  readOriginal(p: string): string | null {
    if (!this.beforeCache.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.beforeCache.set(p, value);
    }
    return this.beforeCache.get(p)!;
  }

  // True when the path exists right now: as an edited file, or on disk
  // (file or directory).
  exists(p: string): boolean {
    if (this.pending.has(p)) return this.pending.get(p) !== null;
    return this.existsOnDisk(p);
  }

  // Current contents, or null when the file does not exist right now
  // (a directory counts as missing).
  read(p: string): string | null {
    if (this.pending.has(p)) return this.pending.get(p)!;
    return this.readOriginal(p);
  }

  write(p: string, value: string | null): void {
    this.pending.set(p, value);
  }
}

// Every position where O occurs in rows, overlapping positions allowed.
function matchPositions(
  rows: string[],
  wanted: string[],
  tier: number,
): number[] {
  if (wanted.length === 0) return [];
  const keys = wanted.map((row) => keyOf(row, tier));
  const found: number[] = [];
  outer: for (let i = 0; i + wanted.length <= rows.length; i++) {
    for (let k = 0; k < wanted.length; k++) {
      if (keyOf(rows[i + k]!, tier) !== keys[k]!) continue outer;
    }
    found.push(i);
  }
  return found;
}

// The first tier (0, 1, 2 — or only 0 when strict) at which O occurs,
// with all of its positions.
function firstTier(
  rows: string[],
  wanted: string[],
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = matchPositions(rows, wanted, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// As firstTier, but only occurrences at or after `from`.
function firstTierAt(
  rows: string[],
  wanted: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = matchPositions(rows, wanted, tier).filter(
      (p) => p >= from,
    );
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// The replacement lines for a matched O at position pos. A context line is
// written as the file's own matched line, never the patch's. At tier 2,
// every other new line is re-indented: the leading whitespace of the
// file's first matched line takes the place of the leading whitespace of
// O's first line.
function buildReplacement(
  oldLines: string[],
  newLines: string[],
  contextOf: number[],
  fileRows: string[],
  pos: number,
  tier: number,
): string[] {
  const out: string[] = [];
  let fileIndent = '';
  let patchIndent = '';
  if (tier === 2) {
    fileIndent = indentPrefix(fileRows[pos] ?? '');
    patchIndent = indentPrefix(oldLines[0] ?? '');
  }
  for (let k = 0; k < newLines.length; k++) {
    const oldIndex = contextOf[k];
    if (oldIndex !== undefined && oldIndex >= 0) {
      out.push(fileRows[pos + oldIndex]!);
      continue;
    }
    let line = newLines[k]!;
    if (
      tier === 2 &&
      line !== '' &&
      line.trim() !== '' &&
      line.startsWith(patchIndent)
    ) {
      line = fileIndent + line.slice(patchIndent.length);
    }
    out.push(line);
  }
  return out;
}

interface ChunkSplit {
  oldLines: string[];
  newLines: string[];
  contextOf: number[];
  noNewlineAtEnd: boolean;
}

// A chunk body (a unified hunk or a V4A chunk) split into its old lines,
// its new lines, and, for each new line, the old line it is a context
// copy of (-1 when it is not). A backslash line is a marker for the line
// before it, not a line of its own. `noNewlineAtEnd` says a backslash line
// follows the chunk's last context or + line.
function splitChunk(body: string[]): ChunkSplit {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const contextOf: number[] = [];
  let oldIndex = 0;
  let lastCounted = -1;
  for (let k = 0; k < body.length; k++) {
    const line = body[k]!;
    if (line === '') {
      oldLines.push('');
      newLines.push('');
      contextOf.push(oldIndex);
      oldIndex++;
      lastCounted = k;
    } else if (line[0] === ' ') {
      const text = line.slice(1);
      oldLines.push(text);
      newLines.push(text);
      contextOf.push(oldIndex);
      oldIndex++;
      lastCounted = k;
    } else if (line[0] === '-') {
      oldLines.push(line.slice(1));
      oldIndex++;
    } else if (line[0] === '+') {
      newLines.push(line.slice(1));
      contextOf.push(-1);
      lastCounted = k;
    }
    // '\' lines are markers, not part of the old or new lines.
  }
  const noNewlineAtEnd =
    lastCounted >= 0 &&
    body[lastCounted + 1] !== undefined &&
    body[lastCounted + 1]![0] === '\\';
  return { oldLines, newLines, contextOf, noNewlineAtEnd };
}

// The first line at or after `cursor` equal to the anchor, at the first
// tier with one; -1 when there is none.
function anchorPosition(
  rows: string[],
  anchor: string,
  cursor: number,
  strict: boolean,
): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const wanted = keyOf(anchor, tier);
    for (let i = cursor; i < rows.length; i++) {
      if (keyOf(rows[i]!, tier) === wanted) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function guessFormat(rows: string[]): PatchFormat | null {
  const first = rows.findIndex((row) => !isBlank(row));
  if (first < 0) return null;
  if (rows[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = rows[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (rows.some((row) => row.trimEnd() === '<<<<<<< SEARCH')) {
    return 'search-replace';
  }
  if (
    rows.some(
      (row, i) =>
        row.startsWith('diff --git ') ||
        (row.startsWith('--- ') &&
          (rows[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonApplier(value: unknown): Applier | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text;
    return (ws) => {
      if (!isSafePath(path)) throw new EditFailure('unsafe', path);
      if (ws.exists(path)) throw new EditFailure('exists', path);
      ws.write(path, text);
    };
  }
  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (ws) => {
      if (!isSafePath(path)) throw new EditFailure('unsafe', path);
      const before = ws.read(path);
      if (before === null) throw new EditFailure('missing', path);
      // In a CRLF file the file text and both strings are read with
      // every \r\n as \n, and the result is written back with \r\n.
      const feed = before.indexOf('\n');
      const crlf = feed > 0 && before[feed - 1] === '\r';
      const toLf = (s: string): string =>
        crlf ? s.replaceAll('\r\n', '\n') : s;
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) {
        count++;
      }
      if (count === 0) throw new EditFailure('no-match', path);
      if (count > 1) throw new EditFailure('ambiguous', path);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      ws.write(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const line = obj.insert_line;
    const added = splitPatchText(obj.new_str);
    return (ws) => {
      if (!isSafePath(path)) throw new EditFailure('unsafe', path);
      const before = ws.read(path);
      if (before === null) throw new EditFailure('missing', path);
      const { rows, eol, terminated } = splitText(before);
      if (line < 0 || line > rows.length) {
        throw new EditFailure('no-match', path);
      }
      rows.splice(line, 0, ...added);
      ws.write(path, joinText(rows, eol, terminated));
    };
  }
  return null;
}

function readJsonPatch(text: string, rows: string[]): Applier[] {
  const first = rows.findIndex((row) => !isBlank(row));
  if (first < 0) throw new ParseFailure('error: parse 1');
  const appliers: Applier[] = [];
  // One JSON array: any fault is a parse error at the line where the
  // array starts.
  if (rows[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFailure(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) {
      throw new ParseFailure(`error: parse ${first + 1}`);
    }
    for (const item of parsed) {
      const applier = jsonApplier(item);
      if (applier === null) {
        throw new ParseFailure(`error: parse ${first + 1}`);
      }
      appliers.push(applier);
    }
    return appliers;
  }
  // JSON Lines: one edit object per line, blank lines ignored; a line not
  // holding one valid edit object is a parse error at that line.
  rows.forEach((row, i) => {
    if (isBlank(row)) return;
    let applier: Applier | null = null;
    try {
      applier = jsonApplier(JSON.parse(row));
    } catch {
      applier = null;
    }
    if (applier === null) throw new ParseFailure(`error: parse ${i + 1}`);
    appliers.push(applier);
  });
  return appliers;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  start: number;
  body: string[];
}

interface DiffSection {
  oldName: string | null;
  newName: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

// The path of a --- or +++ header line: the text after four characters, up
// to the first tab, with surrounding spaces removed; /dev/null is no file.
function pathFromHeader(line: string): string | null {
  const raw = line.slice(4);
  const upToTab = raw.split('\t')[0]!;
  const p = upToTab.trim();
  if (p === '/dev/null') return null;
  return stripPrefix(p);
}

function hunkStart(line: string): number | null {
  const found = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!found) return null;
  return parseInt(found[1]!, 10);
}

function hunkBody(
  rows: string[],
  start: number,
): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < rows.length) {
    const line = rows[i]!;
    if (
      line.startsWith('--- ') &&
      (rows[i + 1] ?? '').startsWith('+++ ')
    ) {
      break;
    }
    if (line.startsWith('diff --git ')) break;
    if (
      line === '' ||
      line[0] === ' ' ||
      line[0] === '-' ||
      line[0] === '+' ||
      line[0] === '\\'
    ) {
      body.push(line);
      i++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function applyHunkList(
  before: string,
  hunks: Hunk[],
  strict: boolean,
  path: string,
): string {
  let { rows, eol, terminated } = splitText(before);
  let drift = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines, contextOf, noNewlineAtEnd } = splitChunk(
      hunk.body,
    );
    if (oldLines.length > 0) {
      const found = firstTier(rows, oldLines, strict);
      if (!found) throw new EditFailure('no-match', path);
      // The occurrence whose position is nearest to start-1+drift; ties
      // go to the earlier one.
      const target = hunk.start - 1 + drift;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const replacement = buildReplacement(
        oldLines,
        newLines,
        contextOf,
        rows,
        best,
        found.tier,
      );
      const toEnd = best + oldLines.length === rows.length;
      rows = [
        ...rows.slice(0, best),
        ...replacement,
        ...rows.slice(best + oldLines.length),
      ];
      // When a hunk's matched lines run to the end of the file, the
      // result ends with a line break unless a \ line follows the hunk's
      // last context or + line.
      if (toEnd) terminated = !noNewlineAtEnd;
      drift += newLines.length - oldLines.length;
    } else {
      // Empty O: the new lines are inserted after the first start+drift
      // lines (all of them when the file has fewer).
      const at = Math.max(0, Math.min(hunk.start + drift, rows.length));
      const atEnd = at === rows.length;
      rows = [...rows.slice(0, at), ...newLines, ...rows.slice(at)];
      if (atEnd) terminated = !noNewlineAtEnd;
      drift += newLines.length;
    }
  }
  return joinText(rows, eol, terminated);
}

function sectionApplier(section: DiffSection, strict: boolean): Applier {
  return (ws) => {
    const oldName = section.oldName;
    const newName = section.newName;
    // Creation: the old path is /dev/null, or a `new file mode` line.
    if (section.isNew || oldName === null) {
      if (newName === null) throw new EditFailure('unsafe', '');
      if (!isSafePath(newName)) throw new EditFailure('unsafe', newName);
      if (ws.exists(newName)) throw new EditFailure('exists', newName);
      // The file is the + lines of all its hunks, in order.
      const added: string[] = [];
      let lastPlusNoNewline = false;
      for (const hunk of section.hunks) {
        for (let k = 0; k < hunk.body.length; k++) {
          const line = hunk.body[k]!;
          if (line[0] === '+') {
            added.push(line.slice(1));
            lastPlusNoNewline =
              hunk.body[k + 1] !== undefined &&
              hunk.body[k + 1]![0] === '\\';
          }
        }
      }
      // A created file ends with a line break unless a \ line follows
      // its last + line.
      const text =
        added.length === 0
          ? ''
          : added.join('\n') + (lastPlusNoNewline ? '' : '\n');
      ws.write(newName, text);
      return;
    }
    // Deletion: the new path is /dev/null, or a `deleted file mode` line.
    if (section.isDeleted || newName === null) {
      if (!isSafePath(oldName)) throw new EditFailure('unsafe', oldName);
      if (ws.read(oldName) === null) throw new EditFailure('missing', oldName);
      ws.write(oldName, null);
      return;
    }
    // Move: the two paths differ.
    if (oldName !== newName) {
      if (!isSafePath(oldName)) throw new EditFailure('unsafe', oldName);
      if (!isSafePath(newName)) throw new EditFailure('unsafe', newName);
      const before = ws.read(oldName);
      if (before === null) throw new EditFailure('missing', oldName);
      if (ws.exists(newName)) throw new EditFailure('exists', newName);
      const text = applyHunkList(before, section.hunks, strict, oldName);
      ws.write(oldName, null);
      ws.write(newName, text);
      ws.renames.push({ from: oldName, to: newName });
      return;
    }
    // Otherwise a change.
    if (!isSafePath(oldName)) throw new EditFailure('unsafe', oldName);
    const before = ws.read(oldName);
    if (before === null) throw new EditFailure('missing', oldName);
    ws.write(oldName, applyHunkList(before, section.hunks, strict, oldName));
  };
}

function readUnified(rows: string[], strict: boolean): Applier[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let sawPair = false;
  let sawHunk = false;
  const openSection = (
    oldName: string | null,
    newName: string | null,
  ): DiffSection => {
    const section: DiffSection = {
      oldName,
      newName,
      isNew: false,
      isDeleted: false,
      hunks: [],
    };
    sections.push(section);
    return section;
  };
  let i = 0;
  while (i < rows.length) {
    const line = rows[i]!;
    // A section starts at `diff --git a/<X> b/<Y>`.
    if (line.startsWith('diff --git ')) {
      const found = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(line);
      if (!found) throw new ParseFailure(`error: parse ${i + 1}`);
      current = openSection(stripPrefix(found[1]!), stripPrefix(found[2]!));
      sawPair = false;
      sawHunk = false;
      i++;
      continue;
    }
    // A section also starts at a --- line followed by a +++ line.
    if (
      line.startsWith('--- ') &&
      (rows[i + 1] ?? '').startsWith('+++ ')
    ) {
      if (current !== null && !sawHunk && !sawPair) {
        // The pair belongs to the current section's header.
        current.oldName = pathFromHeader(line);
        current.newName = pathFromHeader(rows[i + 1]!);
        sawPair = true;
        i += 2;
        continue;
      }
      current = openSection(pathFromHeader(line), pathFromHeader(rows[i + 1]!));
      sawPair = true;
      sawHunk = false;
      i += 2;
      continue;
    }
    if (current === null) {
      // A hunk before any section is a parse error; anything else outside
      // a section is ignored (prose, code fences).
      if (line.startsWith('@@')) {
        throw new ParseFailure(`error: parse ${i + 1}`);
      }
      i++;
      continue;
    }
    if (!sawHunk) {
      // A --- line not followed by a +++ line inside a section's header
      // is a parse error at the line after it.
      if (line.startsWith('--- ')) {
        throw new ParseFailure(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (!sawPair) current.oldName = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!sawPair) current.newName = line.slice(10).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.isNew = true;
        i++;
        continue;
      }
      if (
        line === 'deleted file mode' ||
        line.startsWith('deleted file mode ')
      ) {
        current.isDeleted = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const start = hunkStart(line);
        if (start === null) throw new ParseFailure(`error: parse ${i + 1}`);
        const part = hunkBody(rows, i + 1);
        current.hunks.push({ start, body: part.body });
        sawHunk = true;
        i = part.next;
        continue;
      }
      i++;
      continue;
    }
    // After the first hunk, only @@ starts a new hunk; everything else
    // is ignored.
    if (line.startsWith('@@')) {
      const start = hunkStart(line);
      if (start === null) throw new ParseFailure(`error: parse ${i + 1}`);
      const part = hunkBody(rows, i + 1);
      current.hunks.push({ start, body: part.body });
      i = part.next;
      continue;
    }
    i++;
  }
  return sections.map((section) => sectionApplier(section, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function readSearchReplace(rows: string[], strict: boolean): Applier[] {
  const appliers: Applier[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < rows.length) {
    const line = rows[i]!;
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
      const candidate = rows[j]!;
      if (isBlank(candidate)) continue;
      if (candidate.trim().startsWith('```')) continue;
      path = candidate.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFailure(`error: parse ${searchLine}`);
    // The old lines run to the ======= line; the new lines run to the
    // >>>>>>> REPLACE line.
    let eq = -1;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (rows[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new ParseFailure(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < rows.length; j++) {
      if (rows[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseFailure(`error: parse ${searchLine}`);
    const oldLines = rows.slice(i + 1, eq);
    const newLines = rows.slice(eq + 1, rep);
    const p = path;
    appliers.push((ws) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      // Empty old lines create the file.
      if (oldLines.length === 0) {
        if (ws.exists(p)) throw new EditFailure('exists', p);
        ws.write(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = ws.read(p);
      if (before === null) throw new EditFailure('missing', p);
      const { rows: fileRows, eol, terminated } = splitText(before);
      const found = firstTier(fileRows, oldLines, strict);
      if (!found) throw new EditFailure('no-match', p);
      if (found.positions.length > 1) throw new EditFailure('ambiguous', p);
      const pos = found.positions[0]!;
      const replacement = buildReplacement(
        oldLines,
        newLines,
        oldLines.map(() => -1),
        fileRows,
        pos,
        found.tier,
      );
      fileRows.splice(pos, oldLines.length, ...replacement);
      ws.write(p, joinText(fileRows, eol, terminated));
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  return appliers;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface PatchChunk {
  anchor: string | null;
  atEof: boolean;
  body: string[];
}

function v4aCreate(path: string, body: { n: number; t: string }[]): Applier {
  const fileRows: string[] = [];
  for (const { n, t } of body) {
    if (t.startsWith('+')) fileRows.push(t.slice(1));
    else if (t === '') fileRows.push('');
    else throw new ParseFailure(`error: parse ${n}`);
  }
  return (ws) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (ws.exists(path)) throw new EditFailure('exists', path);
    ws.write(path, fileRows.length === 0 ? '' : fileRows.join('\n') + '\n');
  };
}

function v4aRemove(path: string, body: { n: number; t: string }[]): Applier {
  for (const { n, t } of body) {
    if (!isBlank(t)) throw new ParseFailure(`error: parse ${n}`);
  }
  return (ws) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (ws.read(path) === null) throw new EditFailure('missing', path);
    ws.write(path, null);
  };
}

function v4aModify(
  path: string,
  body: { n: number; t: string }[],
  startLine: number,
  strict: boolean,
): Applier {
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && /^\*\*\* Move to: /.test(body[0]!.t)) {
    moveTo = body[0]!.t.replace(/^\*\*\* Move to: /, '').trim();
    k = 1;
  }
  const chunks: PatchChunk[] = [];
  let current: PatchChunk | null = null;
  let started = false;
  const closeChunk = (): void => {
    if (current !== null) {
      chunks.push(current);
      current = null;
    }
  };
  for (; k < body.length; k++) {
    const { n, t } = body[k]!;
    if (t.startsWith('@@')) {
      closeChunk();
      const anchorText = t.slice(2).trim();
      current = {
        anchor: anchorText === '' ? null : anchorText,
        atEof: false,
        body: [],
      };
      started = true;
      continue;
    }
    if (t === '*** End of File') {
      if (current === null) {
        chunks.push({ anchor: null, atEof: true, body: [] });
      } else {
        current.atEof = true;
        chunks.push(current);
        current = null;
      }
      started = true;
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (current === null) {
        if (started) throw new ParseFailure(`error: parse ${n}`);
        current = { anchor: null, atEof: false, body: [] };
        started = true;
      }
      current.body.push(t);
      continue;
    }
    throw new ParseFailure(`error: parse ${n}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) {
    throw new ParseFailure(`error: parse ${startLine}`);
  }
  return (ws) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) {
      throw new EditFailure('unsafe', moveTo);
    }
    const before = ws.read(path);
    if (before === null) throw new EditFailure('missing', path);
    if (moveTo !== null && ws.exists(moveTo)) {
      throw new EditFailure('exists', moveTo);
    }
    let { rows, eol, terminated } = splitText(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const pos = anchorPosition(rows, chunk.anchor, cursor, strict);
        if (pos < 0) throw new EditFailure('no-match', path);
        cursor = pos + 1;
      }
      const { oldLines, newLines, contextOf } = splitChunk(chunk.body);
      if (oldLines.length > 0) {
        const found = firstTierAt(rows, oldLines, cursor, strict);
        if (!found) throw new EditFailure('no-match', path);
        let pos = found.positions[0]!;
        if (chunk.atEof) {
          // An End of File chunk takes only an occurrence ending at the
          // file's last line.
          const ok = found.positions.filter(
            (p) => p + oldLines.length === rows.length,
          );
          if (ok.length === 0) throw new EditFailure('no-match', path);
          pos = ok[0]!;
        }
        const replacement = buildReplacement(
          oldLines,
          newLines,
          contextOf,
          rows,
          pos,
          found.tier,
        );
        rows = [
          ...rows.slice(0, pos),
          ...replacement,
          ...rows.slice(pos + oldLines.length),
        ];
        cursor = pos + replacement.length;
      } else {
        // Empty O: the new lines are inserted at the cursor (at the end
        // of the file for an End of File chunk).
        const at = chunk.atEof ? rows.length : cursor;
        rows = [...rows.slice(0, at), ...newLines, ...rows.slice(at)];
        cursor = at + newLines.length;
      }
    }
    const text = joinText(rows, eol, terminated);
    if (moveTo !== null) {
      ws.write(path, null);
      ws.write(moveTo, text);
      ws.renames.push({ from: path, to: moveTo });
    } else {
      ws.write(path, text);
    }
  };
}

function readV4a(rows: string[], strict: boolean): Applier[] {
  const first = rows.findIndex((row) => !isBlank(row));
  if (first < 0) throw new ParseFailure('error: parse 1');
  if (rows[first]!.trim() !== '*** Begin Patch') {
    throw new ParseFailure(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isBlank(rows[i]!)) {
      last = i;
      break;
    }
  }
  if (rows[last]!.trim() !== '*** End Patch') {
    throw new ParseFailure(`error: parse ${rows.length + 1}`);
  }
  const appliers: Applier[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(rows[i]!)) {
      i++;
      continue;
    }
    const found = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(rows[i]!);
    if (!found) throw new ParseFailure(`error: parse ${i + 1}`);
    const kind = found[1]!;
    const path = found[2]!.trim();
    const startLine = i + 1;
    // The section's body runs to the next section or to the End Patch
    // line; blank lines at its end are not part of it.
    const body: { n: number; t: string }[] = [];
    let j = i + 1;
    while (j < last) {
      if (/^\*\*\* (Add|Delete|Update) File: /.test(rows[j]!)) break;
      body.push({ n: j + 1, t: rows[j]! });
      j++;
    }
    while (body.length > 0 && isBlank(body[body.length - 1]!.t)) body.pop();
    if (kind === 'Add') appliers.push(v4aCreate(path, body));
    else if (kind === 'Delete') appliers.push(v4aRemove(path, body));
    else appliers.push(v4aModify(path, body, startLine, strict));
    i = j;
  }
  if (appliers.length === 0) throw new ParseFailure('error: parse 1');
  return appliers;
}

// ---------------------------------------------------------------------------
// The CLI (SPEC sections 1-3, 10)
// ---------------------------------------------------------------------------

function readPatch(
  kind: PatchFormat,
  text: string,
  rows: string[],
  strict: boolean,
): Applier[] {
  if (kind === 'json') return readJsonPatch(text, rows);
  if (kind === 'unified') return readUnified(rows, strict);
  if (kind === 'search-replace') return readSearchReplace(rows, strict);
  return readV4a(rows, strict);
}

interface Outcome {
  status: number;
  text: string;
}

function execute(args: string[]): Outcome {
  let format: PatchFormat = 'auto';
  let check = false;
  let strict = false;
  let positional: string | null = null;
  let afterDashDash = false;
  for (const arg of args) {
    if (afterDashDash) {
      if (positional !== null) return { status: 2, text: 'error: usage\n' };
      positional = arg;
      continue;
    }
    if (arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (arg === '--check') {
      if (check) return { status: 2, text: 'error: usage\n' };
      check = true;
      continue;
    }
    if (arg === '--strict') {
      if (strict) return { status: 2, text: 'error: usage\n' };
      strict = true;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const value = arg.slice(9);
      if (format !== 'auto') return { status: 2, text: 'error: usage\n' };
      if (!(KNOWN_FORMATS as readonly string[]).includes(value)) {
        return { status: 2, text: 'error: usage\n' };
      }
      format = value as PatchFormat;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      return { status: 2, text: 'error: usage\n' };
    }
    if (positional !== null) return { status: 2, text: 'error: usage\n' };
    positional = arg;
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
      return { status: 2, text: 'error: no-patch\n' };
    }
  }

  const rows = splitPatchText(text);
  const kind = format === 'auto' ? guessFormat(rows) : format;
  let appliers: Applier[];
  try {
    if (kind === null) throw new ParseFailure('error: format');
    appliers = readPatch(kind, text, rows, strict);
  } catch (e) {
    if (e instanceof ParseFailure) return { status: 2, text: `${e.message}\n` };
    throw e;
  }
  if (appliers.length === 0) return { status: 2, text: 'error: parse 1\n' };

  // Every edit applies in patch order to the tree as earlier edits left
  // it. A failed edit changes nothing, and the edits after it still run,
  // so every failure is reported. When any edit failed, no file is
  // written.
  const ws = new Workspace();
  const failures: { code: string; path: string }[] = [];
  for (const applier of appliers) {
    const savedPending = new Map(ws.pending);
    const savedRenames = ws.renames.length;
    try {
      applier(ws);
    } catch (e) {
      if (e instanceof EditFailure) {
        ws.pending = savedPending;
        ws.renames.length = savedRenames;
        failures.push({ code: e.code, path: e.path });
        continue;
      }
      throw e;
    }
  }
  if (failures.length > 0) {
    const lines: string[] = failures.map((f) => `error: ${f.code} ${f.path}`);
    lines.push(`failed: ${failures.length} of ${appliers.length} edits`);
    return { status: 1, text: lines.join('\n') + '\n' };
  }

  // One row per changed path, in UTF-8 byte order; a move is one R row
  // (by its new path) instead of its D and A rows. An unchanged-bytes
  // file is not listed, and a no-change patch prints only the ok line.
  const rowsOut: { key: string; line: string }[] = [];
  const accounted = new Set<string>();
  for (const move of ws.renames) {
    const wasFrom = ws.readOriginal(move.from);
    const nowFrom = ws.pending.has(move.from)
      ? ws.pending.get(move.from)!
      : undefined;
    const wasTo = ws.readOriginal(move.to);
    const nowTo = ws.pending.has(move.to)
      ? ws.pending.get(move.to)!
      : undefined;
    if (
      wasFrom !== null &&
      nowFrom === null &&
      wasTo === null &&
      nowTo !== null &&
      nowTo !== undefined
    ) {
      rowsOut.push({ key: move.to, line: `R ${move.from} -> ${move.to}` });
      accounted.add(move.from);
      accounted.add(move.to);
    }
  }
  for (const p of [...ws.pending.keys()]) {
    if (accounted.has(p)) continue;
    const was = ws.readOriginal(p);
    const now = ws.pending.get(p)!;
    if (was === now) continue;
    const line =
      was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}`;
    rowsOut.push({ key: p, line });
  }
  rowsOut.sort((a, b) => compareUtf8(a.key, b.key));
  const outLines = rowsOut.map((row) => row.line);
  outLines.push(
    `ok: ${rowsOut.length} ${rowsOut.length === 1 ? 'file' : 'files'}`,
  );

  if (!check) {
    // Deletions first, then writes, so a move into its own directory
    // still works.
    for (const p of [...ws.pending.keys()]) {
      const was = ws.readOriginal(p);
      const now = ws.pending.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
    }
    for (const p of [...ws.pending.keys()]) {
      const was = ws.readOriginal(p);
      const now = ws.pending.get(p)!;
      if (was === now) continue;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { status: 0, text: outLines.join('\n') + '\n' };
}

// ---------------------------------------------------------------------------
// Hand-over: with MAKEFUN_ENV_URL set, this is the trial runner.
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  const { status, text } = execute(process.argv.slice(2));
  process.stdout.write(text);
  process.exitCode = status;
}
