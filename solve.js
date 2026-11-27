// A faster drop-in for makefun-diff 1.0.0.
//
// The rule, as the kit states it: lines are cut after every "\n" (a "\r" is
// part of its line, a last line without "\n" is a line too); the common prefix
// is kept, then the common suffix of what is left; between them Myers's
// greedy search keeps, on each diagonal, the path furthest into the old text
// and takes the deletion when a deletion and an insertion reach the same
// point, never moves past either text's end, prunes no edge diagonal, and
// follows every run of equal lines as far as it goes; the first path to reach
// both ends is the script. The patch is then built from that script with 3
// kept lines of context and hunks merged across gaps of at most 6 kept lines.
//
// How this file is faster than the reference: the reference builds its edit
// script as a linked list of freshly allocated objects, one or two per
// diagonal visit, so a case with a few thousand edits churns millions of
// small objects through the collector. This file keeps the same search, step
// for step, but records only one integer per diagonal per depth -- the old
// position reached -- in flat Int32Arrays, and rebuilds the script by walking
// that record backwards, re-applying the same tie-break at every step. Lines
// are also interned to small integers once, so the snake walks compare ints
// instead of re-scanning strings. Nothing about the search order, the
// tie-break, the bounds, or the patch layout differs from the rule above.

/** The patch's first word. */
export const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
export const CONTEXT = 3;

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** "No path on this diagonal": larger than any line count, so the bounds checks below reject it on their own. */
const NO_PATH = 1e9;

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function tokenize(text) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const lines = new Array(last + 1);
  for (let i = 0; i < last; i++) lines[i] = `${parts[i]}\n`;
  if (parts[last] !== '') lines[last] = parts[last];
  else lines.length = last;
  return lines;
}

/**
 * The edit script of the middle slices, as runs [kind, count] in order.
 * A and B hold the interned line ids of the two texts; the slices are
 * A[base .. base+N) and B[base .. base+M). The search is the reference's
 * greedy Myers, with the same tie-break and the same end conditions; the
 * trace keeps every depth's furthest old position per diagonal so the script
 * can be rebuilt by walking backwards.
 */
function myersRuns(A, B, base, N, M) {
  if (N === 0 && M === 0) return [];
  const trace = [];
  // Depth 0: one diagonal, k = 0, at index 1 of a 3-wide row.
  const v0 = new Int32Array(3);
  v0[0] = NO_PATH;
  v0[2] = NO_PATH;
  trace.push(v0);
  let x = -1;
  let y = -1;
  while (x + 1 < N && y + 1 < M && A[base + x + 1] === B[base + y + 1]) {
    x++;
    y++;
  }
  v0[1] = x;
  let D = 0;
  let kF = 0;
  let done = x + 1 >= N && y + 1 >= M;
  for (let d = 1; !done && d <= N + M; d++) {
    const vp = trace[d - 1];
    const vd = new Int32Array(2 * d + 3);
    // The edge diagonal k = -d has only the insertion candidate, from
    // diagonal -d+1 (vp index 1); the edge k = d only the deletion candidate,
    // from diagonal d-1 (vp index 2d-1). The interior diagonals, where both
    // candidates are in range, run below with rolling indices.
    const xInsEdge = vp[1];
    if (xInsEdge + d < M) {
      let nx = xInsEdge;
      let ny = nx + d;
      while (nx + 1 < N && ny + 1 < M && A[base + nx + 1] === B[base + ny + 1]) {
        nx++;
        ny++;
      }
      vd[1] = nx;
      if (nx + 1 >= N && ny + 1 >= M) {
        D = d;
        kF = -d;
        done = true;
      }
    } else {
      vd[1] = NO_PATH;
    }
    if (!done) {
      let iDel = 1;
      let iIns = 3;
      let iV = 3;
      for (let k = -d + 2; k <= d - 2 && !done; k += 2, iDel += 2, iIns += 2, iV += 2) {
        const xDel = vp[iDel];
        const xIns = vp[iIns];
        const canRemove = xDel + 1 < N;
        const canAdd = xIns - k < M;
        if (!canRemove && !canAdd) {
          vd[iV] = NO_PATH;
          continue;
        }
        // The candidate further into the old text, and the deletion on a tie.
        let nx;
        if (canRemove && (!canAdd || xDel + 1 >= xIns)) nx = xDel + 1;
        else nx = xIns;
        let ny = nx - k;
        while (nx + 1 < N && ny + 1 < M && A[base + nx + 1] === B[base + ny + 1]) {
          nx++;
          ny++;
        }
        vd[iV] = nx;
        if (nx + 1 >= N && ny + 1 >= M) {
          D = d;
          kF = k;
          done = true;
        }
      }
    }
    if (!done) {
      const xDelEdge = vp[2 * d - 1];
      if (xDelEdge + 1 < N) {
        let nx = xDelEdge + 1;
        let ny = nx - d;
        while (nx + 1 < N && ny + 1 < M && A[base + nx + 1] === B[base + ny + 1]) {
          nx++;
          ny++;
        }
        vd[2 * d + 1] = nx;
        if (nx + 1 >= N && ny + 1 >= M) {
          D = d;
          kF = d;
          done = true;
        }
      } else {
        vd[2 * d + 1] = NO_PATH;
      }
    }
    trace.push(vd);
  }
  if (!done) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Walk the trace backwards: at each depth the predecessor is the same
  // choice the forward pass made, so the rebuilt script is the one it found.
  const rev = [];
  let d = D;
  let k = kF;
  x = trace[D][kF + D + 1];
  while (d > 0) {
    const vp = trace[d - 1];
    const xDel = k > -d ? vp[k + d - 1] : NO_PATH;
    const xIns = k < d ? vp[k + d + 1] : NO_PATH;
    const canRemove = xDel + 1 < N;
    const canAdd = xIns - k < M;
    let xAfter;
    let kPred;
    let kind;
    if (canRemove && (!canAdd || xDel + 1 >= xIns)) {
      xAfter = xDel + 1;
      kPred = k - 1;
      kind = DELETE;
    } else {
      xAfter = xIns;
      kPred = k + 1;
      kind = INSERT;
    }
    const snake = x - xAfter;
    if (snake > 0) rev.push([KEEP, snake]);
    rev.push([kind, 1]);
    x = vp[kPred + d];
    k = kPred;
    d--;
  }
  const keep0 = x + 1;
  if (keep0 > 0) rev.push([KEEP, keep0]);
  rev.reverse();
  return rev;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;

  // Intern every line to a small integer, once, so all later comparisons
  // (prefix, suffix, snake walks) compare ints instead of strings.
  const ids = new Map();
  let next = 0;
  const A = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let id = ids.get(a[i]);
    if (id === undefined) {
      id = next++;
      ids.set(a[i], id);
    }
    A[i] = id;
  }
  const B = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    let id = ids.get(b[j]);
    if (id === undefined) {
      id = next++;
      ids.set(b[j], id);
    }
    B[j] = id;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  runs.push(...myersRuns(A, B, prefix, n - prefix - suffix, m - prefix - suffix));
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}
