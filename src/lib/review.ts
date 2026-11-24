// "Reviewed" is remembered as a snapshot of what the reviewer saw: one short signature per graded
// question. If a later rubric gives a question a different score, flag or comment for that
// student, the review no longer covers it and the student goes back on the to-review list.
// Rubric edits that don't change a student's outcome leave their review alone.

import type { Cell, StudentResult } from "./grader";

/** question id -> signature of the cell when the student was marked reviewed */
export type ReviewSnapshot = Record<string, string>;
/** user id -> snapshot. null: reviewed before snapshots existed, adopt the current results. */
export type Reviews = Record<string, ReviewSnapshot | null>;

export interface StaleQuestion {
  questionId: string;
  /** score when reviewed (null if not graded by the rubric then) */
  was: number | null;
  wasGraded: boolean;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Signature of what a reviewer sees for one question. Untouched questions have none. */
export function cellSig(c: Cell): string | null {
  if (c.status === "untouched") return null;
  const body = [
    c.status,
    c.score ?? "",
    c.flags.join("\x1f"),
    c.comments.join("\x1f"),
    ...(c.parts ?? []).map((p) => `${p.score}:${p.flags.join("\x1f")}:${p.comments.join("\x1f")}`),
  ].join("\x1e");
  return `${c.score ?? ""}~${hash(body)}`;
}

export function snapshot(r: StudentResult): ReviewSnapshot {
  const out: ReviewSnapshot = {};
  for (const [qid, c] of Object.entries(r.cells)) {
    const s = cellSig(c);
    if (s != null) out[qid] = s;
  }
  return out;
}

function sigScore(sig: string): number | null {
  const s = sig.slice(0, sig.indexOf("~"));
  return s === "" ? null : Number(s);
}

/** Questions whose outcome differs from what the reviewer saw. Empty: the review still holds. */
export function staleQuestions(snap: ReviewSnapshot, r: StudentResult): StaleQuestion[] {
  const out: StaleQuestion[] = [];
  const ids = new Set([...Object.keys(snap), ...Object.keys(r.cells)]);
  for (const qid of ids) {
    const c = r.cells[qid];
    if (!c) continue; // question no longer in the quiz
    const before = snap[qid] ?? null;
    if (before !== cellSig(c)) {
      out.push({ questionId: qid, was: before != null ? sigScore(before) : null, wasGraded: before != null });
    }
  }
  return out;
}

/** Saved state from older versions stored a plain list of user ids. */
export function migrateReviews(reviews: unknown, legacy: unknown): Reviews {
  if (reviews && typeof reviews === "object" && !Array.isArray(reviews)) return reviews as Reviews;
  if (Array.isArray(legacy)) return Object.fromEntries(legacy.map((id) => [String(id), null]));
  return {};
}
