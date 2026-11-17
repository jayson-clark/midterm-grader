// Applies a rubric to every student's responses.
//
// Only questions the rubric covers (questions.<id> or types.<kind>) get a new score; every
// other question keeps its Canvas score and is never written back.

import type { MatchContext, Options, Outcome, PartSpec, QuestionSpec, ScoreSpec } from "./rubric";
import type { Question, QuizData, Response, Student } from "./types";

export interface PartResult {
  label: string;
  text: string;
  score: number;
  max: number | null;
  matched: string[];
  flags: string[];
  comments: string[];
}

export type CellStatus =
  | "graded" // rubric decided the score
  | "untouched" // no rubric entry: Canvas score stands, never written
  | "kept" // rubric says use: canvas
  | "override"; // reviewer typed a score

export interface Cell {
  questionId: string;
  status: CellStatus;
  /** Final score for the question (Canvas's for untouched/kept). */
  score: number | null;
  canvasPoints: number | null;
  max: number | null;
  matched: string[];
  flags: string[];
  comments: string[];
  parts?: PartResult[];
  /** score differs from Canvas */
  changed: boolean;
  /** where the spec came from (questions.93885, types.essay) */
  origin?: string;
}

export interface StudentResult {
  userId: string;
  cells: Record<string, Cell>;
  canvasScore: number | null;
  newScore: number | null;
  changed: boolean;
  flagged: boolean;
}

export interface Override {
  score?: number;
  comment?: string;
}

/** key: `${userId}:${questionId}` */
export type Overrides = Record<string, Override>;

export const overrideKey = (userId: string, questionId: string) => `${userId}:${questionId}`;

export function normalize(text: string, o: Options): string {
  const t = text.replace(/ /g, " ").replace(/\r/g, "");
  if (o.whitespace === "keep") return t;
  if (o.whitespace === "collapse") return t.replace(/\s+/g, " ").trim();
  return t.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join("\n").trim();
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
/** Blank scores keep more precision so 6 × (8/6) still adds up to 8. */
const fine = (n: number) => Math.round(n * 1e9) / 1e9;

function resolve(s: ScoreSpec, ctx: MatchContext, flags: string[]): number {
  if (s.kind === "points") return s.value;
  if (s.kind === "keep") return ctx.canvasPoints ?? 0;
  if (ctx.max == null) {
    flags.push("max points unknown: set points: in the rubric");
    return 0;
  }
  return s.value * ctx.max;
}

function apply(o: Outcome, ctx: MatchContext, acc: { flags: string[]; comments: string[] }): number {
  if (o.flag) acc.flags.push(o.flag);
  if (o.comment) acc.comments.push(o.comment);
  return resolve(o.score, ctx, acc.flags);
}

export function evalPart(part: PartSpec, text: string, ctx: MatchContext, label = ""): PartResult {
  const r: PartResult = { label, text, score: 0, max: ctx.max, matched: [], flags: [], comments: [] };
  const hits = part.rules.filter((rule) => {
    try {
      return rule.test(text, ctx);
    } catch {
      r.flags.push(`rule "${rule.label}" failed to run`);
      return false;
    }
  });
  let score: number;
  if (part.mode === "first") {
    if (hits.length) {
      r.matched.push(hits[0].label);
      score = apply(hits[0], ctx, r);
    } else {
      r.matched.push("no rule matched → otherwise");
      score = apply(part.otherwise, ctx, r);
    }
  } else if (part.mode === "sum") {
    if (!hits.length && !part.start) {
      r.matched.push("no rule matched → otherwise");
      score = apply(part.otherwise, ctx, r);
    } else {
      score = part.start ? resolve(part.start, ctx, r.flags) : 0;
      for (const h of hits) {
        r.matched.push(h.label);
        score += apply(h, ctx, r);
      }
    }
  } else {
    if (hits.length) {
      const scored = hits.map((h) => ({ h, v: resolve(h.score, ctx, []) }));
      const best = scored.reduce((a, b) => (b.v > a.v ? b : a));
      r.matched.push(best.h.label);
      score = apply(best.h, ctx, r);
    } else {
      r.matched.push("no rule matched → otherwise");
      score = apply(part.otherwise, ctx, r);
    }
  }
  if (ctx.max != null) score = Math.min(score, ctx.max);
  r.score = fine(Math.max(0, score));
  return r;
}

function blankSpec(spec: QuestionSpec, q: Question, i: number): PartSpec | null {
  const b = spec.blanks;
  if (!b) return null;
  if (Array.isArray(b)) return b[i] ?? null;
  const name = q.blankIds[i];
  return b[name] ?? b[`blank${i + 1}`] ?? b[String(i + 1)] ?? null;
}

export function gradeQuestion(q: Question, spec: QuestionSpec | undefined, resp: Response | undefined): Cell {
  const canvasPoints = resp?.canvasPoints ?? null;
  const max = spec?.points ?? q.pointsPossible;
  const base: Cell = {
    questionId: q.id, status: "untouched", score: canvasPoints, canvasPoints, max,
    matched: [], flags: [], comments: [], changed: false, origin: spec?.origin,
  };
  if (!spec) return base;
  if (spec.keep) return { ...base, status: "kept", matched: ["use: canvas"] };

  const cell: Cell = { ...base, status: "graded" };
  const o = spec.options;
  const answered = !!resp && resp.answered && resp.text.trim() !== "";

  if (!answered && o.blankAnswers !== "rules") {
    if (o.blankAnswers === "zero") return { ...cell, score: 0, matched: ["blank answer → 0"], changed: (canvasPoints ?? 0) !== 0 };
    const flagged = o.blankAnswers === "flag";
    return { ...cell, status: "graded", score: canvasPoints, matched: ["blank answer → Canvas score"], flags: flagged ? ["blank answer"] : [] };
  }

  const ctx: MatchContext = { canvasPoints, max };

  if (spec.blanks && (q.kind === "fill_blank" || q.kind === "dropdown")) {
    const parts = resp?.parts ?? [resp?.text ?? ""];
    if (resp?.partsMismatch) {
      return {
        ...cell, score: canvasPoints,
        flags: [`couldn't split the answer into ${q.blankIds.length} blanks (got ${parts.length}); Canvas score kept`],
        matched: ["answer split failed"],
      };
    }
    const n = Math.max(q.blankIds.length, parts.length);
    const specs = Array.from({ length: n }, (_, i) => blankSpec(spec, q, i));
    const fixed = specs.reduce((s, b) => s + (b?.points ?? 0), 0);
    const free = specs.filter((b) => b?.points == null).length;
    const share = max == null ? null : free ? Math.max(0, (max - fixed) / free) : 0;
    const results: PartResult[] = [];
    for (let i = 0; i < n; i++) {
      const bs = specs[i];
      const bmax = bs?.points ?? share;
      const label = q.blankIds[i] ? `Blank ${i + 1} (${q.blankIds[i]})` : `Blank ${i + 1}`;
      const text = normalize(parts[i] ?? "", o);
      if (!bs) {
        // No rule for this blank: estimate its share of Canvas's score.
        const est = canvasPoints != null && max ? fine((canvasPoints / max) * (bmax ?? 0)) : 0;
        const flags = canvasPoints != null && max && canvasPoints > 0 && canvasPoints < max ? ["no rule for this blank; used its share of Canvas's score"] : [];
        results.push({ label, text, score: est, max: bmax, matched: ["no rule → Canvas share"], flags, comments: [] });
        continue;
      }
      if (!text && o.blankAnswers !== "rules") {
        results.push({ label, text, score: 0, max: bmax, matched: ["blank → 0"], flags: o.blankAnswers === "flag" ? ["blank answer"] : [], comments: [] });
        continue;
      }
      results.push(evalPart(bs, text, { canvasPoints: null, max: bmax }, label));
    }
    let score = results.reduce((s, p) => s + p.score, 0);
    if (max != null) score = Math.min(score, max);
    score = round(score);
    return {
      ...cell, score, parts: results,
      matched: results.map((p) => `${p.label}: ${p.matched.join("; ")}`),
      flags: results.flatMap((p) => p.flags.map((f) => `${p.label}: ${f}`)),
      comments: results.flatMap((p) => p.comments),
      changed: canvasPoints == null || Math.abs(score - canvasPoints) > 1e-3,
    };
  }

  const text = normalize(resp?.text ?? "", o);
  const r = evalPart(spec, text, ctx);
  return {
    ...cell, score: round(r.score), matched: r.matched, flags: r.flags, comments: r.comments,
    changed: canvasPoints == null || Math.abs(r.score - canvasPoints) > 1e-3,
  };
}

export function gradeStudent(quiz: QuizData, specs: Map<string, QuestionSpec>, s: Student, overrides: Overrides = {}): StudentResult {
  const cells: Record<string, Cell> = {};
  let delta = 0;
  let sum = 0;
  for (const q of quiz.questions) {
    let cell = gradeQuestion(q, specs.get(q.id), s.responses[q.id]);
    const ov = overrides[overrideKey(s.userId, q.id)];
    if (ov && (ov.score != null || ov.comment != null)) {
      const score = ov.score ?? cell.score;
      cell = {
        ...cell,
        status: "override",
        score,
        comments: ov.comment != null ? (ov.comment ? [ov.comment] : []) : cell.comments,
        flags: [],
        changed: score != null && (cell.canvasPoints == null || Math.abs(score - cell.canvasPoints) > 1e-3),
      };
    }
    cells[q.id] = cell;
    if (cell.status === "graded" || cell.status === "override") delta += (cell.score ?? 0) - (cell.canvasPoints ?? 0);
    sum += cell.score ?? 0;
  }
  const newScore = s.canvasScore != null ? round(s.canvasScore + delta) : round(sum);
  const vals = Object.values(cells);
  return {
    userId: s.userId,
    cells,
    canvasScore: s.canvasScore,
    newScore,
    changed: vals.some((c) => c.changed && (c.status === "graded" || c.status === "override")),
    flagged: vals.some((c) => c.flags.length > 0),
  };
}

export function gradeAll(quiz: QuizData, specs: Map<string, QuestionSpec>, overrides: Overrides = {}): Map<string, StudentResult> {
  return new Map(quiz.students.map((s) => [s.userId, gradeStudent(quiz, specs, s, overrides)]));
}

/** Distinct answers to a question (or one blank), with counts and how they're scored. */
export interface AnswerGroup {
  text: string;
  students: string[];
  scores: number[];
  canvas: (number | null)[];
  matched: string;
  flagged: boolean;
}

export function answerGroups(quiz: QuizData, results: Map<string, StudentResult>, questionId: string, blankIndex: number | null): AnswerGroup[] {
  const groups = new Map<string, AnswerGroup>();
  for (const s of quiz.students) {
    const resp = s.responses[questionId];
    const cell = results.get(s.userId)?.cells[questionId];
    if (!resp || !cell) continue;
    let text: string;
    let score: number | null;
    let matched: string;
    let flagged: boolean;
    if (blankIndex != null) {
      text = resp.parts?.[blankIndex] ?? "";
      const part = cell.parts?.[blankIndex];
      score = part?.score ?? null;
      matched = part?.matched.join("; ") ?? cell.matched.join("; ");
      flagged = (part?.flags.length ?? 0) > 0;
    } else {
      text = resp.text;
      score = cell.score;
      matched = cell.matched.join("; ");
      flagged = cell.flags.length > 0;
    }
    const key = text.replace(/\s+/g, " ").trim();
    const g = groups.get(key) ?? { text: key, students: [], scores: [], canvas: [], matched, flagged: false };
    g.students.push(s.userId);
    g.scores.push(score ?? 0);
    g.canvas.push(blankIndex == null ? resp.canvasPoints : null);
    g.flagged ||= flagged;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.students.length - a.students.length || a.text.localeCompare(b.text));
}
