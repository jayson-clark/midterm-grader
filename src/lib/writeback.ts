// Turning grading results into Canvas updates, and sending them.
//
// Classic quizzes: per-question scores (and comments, only where the rubric or reviewer
// wrote one) on the quiz submission. Only rubric-graded / overridden questions are sent.
// New Quizzes from a CSV report: Canvas has no public API for per-question scores, so the
// assignment's total score is set to Canvas total - Canvas points on rubric questions + rubric points.
// New Quizzes loaded through its API: per-question scores are saved on the attempt the way
// SpeedGrader does (see saveNqAttempt); comments go to Canvas as a submission comment.

import { api, listSubmissions, nqAttempt, nqQuiz, saveBackup } from "./canvas";
import type { ApiItemResult } from "./sources/newQuizzesApi";
import type { StudentResult } from "./grader";
import type { QuizData } from "./types";

export interface QuestionChange {
  questionId: string;
  position: number;
  from: number | null;
  to: number;
  comment?: string;
}

export interface PlannedWrite {
  userId: string;
  name: string;
  canvasScore: number | null;
  newScore: number | null;
  questions: QuestionChange[];
  /** New Quizzes: whether the total score changes (false = comment only) */
  setTotal?: boolean;
  /** New Quizzes: submission comment (question comments, plus score changes if asked) */
  summaryComment?: string;
  /** why this student can't be written, if so */
  blocked?: string;
}

export interface WriteOptions {
  /** New Quizzes: also list the per-question score changes in the submission comment */
  summaryComment: boolean;
  /** only write students marked reviewed */
  onlyReviewed: boolean;
  reviewed: Set<string>;
}

const fmt = (n: number | null) => (n == null ? "–" : String(Math.round(n * 100) / 100));

export function planWrites(quiz: QuizData, results: Map<string, StudentResult>, opts: WriteOptions): PlannedWrite[] {
  const qpos = new Map(quiz.questions.map((q) => [q.id, q.position]));
  const out: PlannedWrite[] = [];
  for (const s of quiz.students) {
    if (opts.onlyReviewed && !opts.reviewed.has(s.userId)) continue;
    const r = results.get(s.userId);
    if (!r) continue;
    const questions: QuestionChange[] = [];
    for (const c of Object.values(r.cells)) {
      if (c.status !== "graded" && c.status !== "override") continue;
      if (c.score == null) continue;
      const comment = c.comments.join("\n").trim() || undefined;
      const scoreChanged = c.canvasPoints == null || Math.abs(c.score - c.canvasPoints) > 1e-3;
      if (!scoreChanged && !comment) continue;
      questions.push({ questionId: c.questionId, position: qpos.get(c.questionId) ?? 0, from: c.canvasPoints, to: c.score, comment });
    }
    questions.sort((a, b) => a.position - b.position);
    if (!questions.length) continue;
    const w: PlannedWrite = { userId: s.userId, name: s.name, canvasScore: s.canvasScore, newScore: r.newScore, questions };
    if (quiz.source === "classic") {
      if (!s.quizSubmissionId) w.blocked = "quiz submission not found";
    } else if (quiz.source === "new_quizzes_api") {
      if (!s.nq) w.blocked = "New Quizzes attempt not found";
      else if (quiz.readOnly) w.blocked = "New Quizzes reports this quiz as read-only";
      w.setTotal = false;
      const notes = questions.filter((q) => q.comment).map((q) => `Q${q.position}: ${q.comment}`);
      if (notes.length) w.summaryComment = notes.join("\n");
    } else {
      // New Quizzes has no per-question comments, so they all go into one submission comment.
      const totalChanged = r.newScore != null && s.canvasScore != null && Math.abs(r.newScore - s.canvasScore) >= 1e-3;
      const notes = questions.filter((q) => q.comment).map((q) => `Q${q.position}: ${q.comment}`);
      const changes = questions.filter((q) => q.from == null || Math.abs(q.to - q.from) > 1e-3);
      if (!totalChanged && !notes.length) continue; // score changes cancel out and nothing to say
      if (r.newScore == null || s.canvasScore == null) w.blocked = "total score unknown";
      w.setTotal = totalChanged;
      const lines = [...notes];
      if (opts.summaryComment && totalChanged && changes.length) {
        lines.push(`Score changes: ${changes.map((q) => `Q${q.position} ${fmt(q.from)} → ${fmt(q.to)}`).join(", ")}. Total ${fmt(s.canvasScore)} → ${fmt(r.newScore)}.`);
      }
      if (lines.length) w.summaryComment = lines.join("\n");
    }
    out.push(w);
  }
  return out;
}

export interface WriteResult {
  userId: string;
  name: string;
  ok: boolean;
  message: string;
}

export async function backupBeforeWrite(quiz: QuizData, plan: PlannedWrite[]): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const body = {
    created: new Date().toISOString(),
    source: quiz.source,
    courseId: quiz.courseId,
    assignmentId: quiz.assignmentId,
    quizId: quiz.quizId,
    title: quiz.title,
    note: "Canvas scores before Midterm Grader wrote changes. 'from' values are what Canvas had.",
    students: plan.map((p) => ({ userId: p.userId, name: p.name, canvasScore: p.canvasScore, newScore: p.newScore, questions: p.questions })),
  };
  return saveBackup(`${quiz.assignmentId ?? "quiz"}_${stamp}`, JSON.stringify(body, null, 2));
}

export async function executeWrites(
  quiz: QuizData,
  plan: PlannedWrite[],
  onProgress: (done: number, total: number, last: WriteResult) => void,
): Promise<WriteResult[]> {
  if (!quiz.courseId || !quiz.assignmentId) throw new Error("No Canvas course/assignment selected.");
  const results: WriteResult[] = [];
  const todo = plan.filter((p) => !p.blocked);
  let current = new Map<string, number | null>();
  if (quiz.source === "new_quizzes_csv") {
    // The report may be older than Canvas: refuse to overwrite totals that changed since.
    const subs = await listSubmissions(quiz.courseId, quiz.assignmentId, []);
    current = new Map(subs.map((s) => [String(s.user_id), s.score]));
  }
  const students = new Map(quiz.students.map((s) => [s.userId, s]));
  for (const p of plan.filter((x) => x.blocked)) {
    results.push({ userId: p.userId, name: p.name, ok: false, message: `Skipped: ${p.blocked}` });
  }
  let done = 0;
  for (const p of todo) {
    let res: WriteResult;
    try {
      if (quiz.source === "new_quizzes_api") {
        const s = students.get(p.userId)!;
        const msg = await saveNqAttempt(quiz, s.nq!, p.questions);
        if (p.summaryComment) {
          await api(`/courses/${quiz.courseId}/assignments/${quiz.assignmentId}/submissions/${p.userId}`, { method: "PUT", body: { comment: { text_comment: p.summaryComment } } });
        }
        res = { userId: p.userId, name: p.name, ok: true, message: msg + (p.summaryComment ? "; comment added" : "") };
      } else if (quiz.source === "classic") {
        const s = students.get(p.userId)!;
        const questions: Record<string, { score: number; comment?: string }> = {};
        for (const q of p.questions) questions[q.questionId] = q.comment ? { score: q.to, comment: q.comment } : { score: q.to };
        const out = await api<{ quiz_submissions: { score: number }[] }>(
          `/courses/${quiz.courseId}/quizzes/${quiz.quizId}/submissions/${s.quizSubmissionId}`,
          { method: "PUT", body: { quiz_submissions: [{ attempt: s.attempt, questions }] } },
        );
        res = { userId: p.userId, name: p.name, ok: true, message: `Updated ${p.questions.length} question(s); quiz score now ${fmt(out.quiz_submissions?.[0]?.score ?? null)}` };
      } else {
        const now = current.get(p.userId);
        if (now === undefined) throw new Error("no submission on Canvas for this student");
        if (p.setTotal && (now == null || p.canvasScore == null || Math.abs(now - p.canvasScore) > 1e-3)) {
          throw new Error(`Canvas score changed since the report was exported (report ${fmt(p.canvasScore)}, Canvas now ${fmt(now)}). Re-export the report.`);
        }
        const body: Record<string, unknown> = {};
        if (p.setTotal) body.submission = { posted_grade: String(p.newScore) };
        if (p.summaryComment) body.comment = { text_comment: p.summaryComment };
        await api(`/courses/${quiz.courseId}/assignments/${quiz.assignmentId}/submissions/${p.userId}`, { method: "PUT", body });
        const what = [p.setTotal ? `Total ${fmt(p.canvasScore)} → ${fmt(p.newScore)}` : "", p.summaryComment ? "comment added" : ""].filter(Boolean);
        res = { userId: p.userId, name: p.name, ok: true, message: what.join("; ") };
      }
    } catch (e) {
      res = { userId: p.userId, name: p.name, ok: false, message: (e as Error).message };
    }
    results.push(res);
    onProgress(++done, todo.length, res);
  }
  return results;
}

// ---------- New Quizzes (API): per-question scores on the attempt ----------

/** snake_case → camelCase on keys that are snake_case; ids, UUIDs and plain words are left alone. */
function camelKey(k: string): string {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(k) ? k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()) : k;
}
export function camelizeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelizeKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [camelKey(k), camelizeKeys(x)]));
  }
  return v;
}

/**
 * The body New Quizzes' grading screen posts to /api/quiz_sessions/:id/results: every question's
 * result as its client stores it (keys camelCased, UUID keys untouched), minus id and
 * gradingMethod, with new scores on the changed questions only.
 */
export function buildNqResultsPayload(current: ApiItemResult[], newScores: Map<string, number>): unknown[] {
  return current.map((r) => {
    const { id: _id, grading_method: _gm, ...rest } = r as ApiItemResult & { id?: unknown; grading_method?: unknown };
    void _id; void _gm;
    const changed = newScores.get(String(r.item_id));
    return camelizeKeys(changed != null ? { ...rest, score: changed } : rest);
  });
}

interface NqQuizSession { authoritative_result?: { id: string | number; fudge_points?: number | null } | null }

async function saveNqAttempt(quiz: QuizData, nq: { participantSessionId: string; quizSessionId: string }, changes: QuestionChange[]): Promise<string> {
  const key = quiz.nqKey!;
  const qsid = await nqAttempt(key, nq.participantSessionId); // fresh token for this attempt
  const qs = await nqQuiz<NqQuizSession>(key, qsid, "GET", `/api/quiz_sessions/${qsid}`);
  const rid = qs.authoritative_result?.id;
  if (rid == null) throw new Error("this attempt has no result to grade yet");
  const resultsPath = `/api/quiz_sessions/${qsid}/results/${rid}/session_item_results`;
  const current = await nqQuiz<ApiItemResult[]>(key, qsid, "GET", resultsPath, undefined, true);

  // Refuse if anyone changed these questions since the quiz was loaded.
  const scores = new Map<string, number>();
  for (const c of changes.filter((c) => c.from == null || Math.abs(c.to - c.from) > 1e-3)) {
    const cur = current.find((r) => String(r.item_id) === c.questionId);
    if (!cur) throw new Error(`Q${c.position} isn't in this attempt`);
    if (c.from != null && Math.abs((cur.score ?? 0) - c.from) > 1e-3) {
      throw new Error(`Q${c.position} changed in New Quizzes since you loaded the quiz (was ${fmt(c.from)}, now ${fmt(cur.score)}). Reload and try again.`);
    }
    scores.set(c.questionId, c.to);
  }
  if (!scores.size) return "no score changes";

  const saved = await nqQuiz<{ id?: string | number; score?: number | null } | null>(key, qsid, "POST", `/api/quiz_sessions/${qsid}/results`, {
    results: buildNqResultsPayload(current, scores),
    fudge_points: qs.authoritative_result?.fudge_points ?? null,
  });

  // Saving creates a new result for the attempt; check the scores on whichever result is current now.
  const qsAfter = await nqQuiz<NqQuizSession>(key, qsid, "GET", `/api/quiz_sessions/${qsid}`).catch(() => null);
  const ridAfter = qsAfter?.authoritative_result?.id ?? saved?.id ?? rid;
  const after = await nqQuiz<ApiItemResult[]>(key, qsid, "GET", `/api/quiz_sessions/${qsid}/results/${ridAfter}/session_item_results`, undefined, true).catch(() => null);
  const detail = `result ${rid} → ${ridAfter}; New Quizzes returned ${saved == null ? "nothing" : `result ${saved.id ?? "?"} with score ${fmt(saved.score ?? null)}`}`;
  if (after) {
    const wrong = [...scores].filter(([id, to]) => {
      const r = after.find((x) => String(x.item_id) === id);
      return !r || Math.abs((r.score ?? 0) - to) > 1e-3;
    });
    if (wrong.length) {
      const got = wrong.map(([id, to]) => `Q${changes.find((c) => c.questionId === id)?.position}: wanted ${fmt(to)}, New Quizzes has ${fmt(after.find((x) => String(x.item_id) === id)?.score ?? null)}`);
      throw new Error(`New Quizzes accepted the save but the score didn't change (${got.join("; ")}; ${detail}). Check this attempt in SpeedGrader.`);
    }
  }
  const list = changes.filter((c) => scores.has(c.questionId)).map((c) => `Q${c.position} ${fmt(c.from)} → ${fmt(c.to)}`);
  return `Saved in New Quizzes: ${list.join(", ")} (${detail})`;
}
