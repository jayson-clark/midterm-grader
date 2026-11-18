// New Quizzes, straight from its API (no CSV export). See src-tauri/src/nq.rs for how access works.
//
// students:   LTI API  GET /api/assignments/:ltiId/participants   (Canvas user id + attempts)
// an attempt: LTI API  GET /api/participant_sessions/:id/grade     (→ Quiz API session; in nq_attempt)
//             Quiz API GET /api/quiz_sessions/:qs                   (authoritative result id, score)
//             Quiz API GET /api/quiz_sessions/:qs/results/:r/session_item_results  (per-question results)
// questions:  Quiz API GET /api/quiz_sessions/:qs/session_items    (prompts, blanks, choices)

import { listSubmissions, nqAttempt, nqLti, nqOpen, nqQuiz } from "../canvas";
import { htmlToText } from "../text";
import type { Kind, Question, QuizData, Response, Student } from "../types";

export const NQ_KIND: Record<string, Kind> = {
  essay: "essay",
  choice: "choice",
  "true-false": "true_false",
  "multi-answer": "multi_answer",
  "rich-fill-blank": "fill_blank",
  "fill-blank": "fill_blank",
  ordering: "ordering",
  matching: "matching",
  numeric: "numeric",
  formula: "formula",
  categorization: "categorization",
  "hot-spot": "hot_spot",
  "file-upload": "file_upload",
};

// ---------- API shapes (only the fields used) ----------

export interface ApiChoice { id: string; item_body?: string; position?: number }
export interface ApiSessionItem {
  position: number;
  question_number?: number | null;
  points_possible: number;
  item?: {
    id?: string;
    item_body?: string;
    interaction_type?: { slug?: string };
    interaction_data?: {
      blanks?: { id: string }[];
      choices?: ApiChoice[] | Record<string, ApiChoice>;
    };
  } | null;
}
export interface ApiItemResult {
  item_id: string;
  position: number;
  points_possible: number;
  score: number | null;
  scored_data?: { value?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}
interface ApiParticipant {
  id: string;
  canvas_user_id?: string;
  user?: { full_name?: string };
  participant_sessions?: { id: string; status?: string; submitted_at?: string | null; created_at?: string; quiz_api_quiz_session_id?: string }[];
}
interface ApiQuizSession {
  id: string | number;
  attempt?: number;
  submitted_at?: string | null;
  authoritative_result?: { id: string | number; score?: number | null; fudge_points?: number | null; points_possible?: number | null } | null;
}

/** Per-question definitions needed to turn results into text. */
export interface ItemDef {
  question: Question;
  blankOrder: string[];
  choiceText: Map<string, string>;
}

// ---------- pure parsing ----------

export function defsFromSessionItems(items: ApiSessionItem[]): Map<string, ItemDef> {
  const defs = new Map<string, ItemDef>();
  const sorted = [...items].filter((si) => si.item?.id).sort((a, b) => a.position - b.position);
  sorted.forEach((si, idx) => {
    const it = si.item!;
    const slug = it.interaction_type?.slug ?? "other";
    const choicesRaw = it.interaction_data?.choices;
    const choices = Array.isArray(choicesRaw) ? choicesRaw : choicesRaw ? Object.values(choicesRaw) : [];
    const choiceText = new Map(choices.map((c) => [c.id, htmlToText(c.item_body ?? "")]));
    const blankOrder = (it.interaction_data?.blanks ?? []).map((b) => b.id);
    defs.set(String(it.id), {
      blankOrder,
      choiceText,
      question: {
        id: String(it.id),
        position: si.question_number ?? idx + 1,
        kind: NQ_KIND[slug] ?? "other",
        rawType: slug,
        text: htmlToText(it.item_body ?? ""),
        pointsPossible: si.points_possible,
        pointsSource: "canvas",
        blankIds: blankOrder.map((_, i) => `blank${i + 1}`),
        choices: choices.map((c) => ({ id: c.id, text: htmlToText(c.item_body ?? ""), correct: null })),
      },
    });
  });
  return defs;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const responded = (v: unknown) => isRec(v) && (v.user_responded === true || (typeof v.user_responded === "string" && v.user_responded !== ""));

/** Turn one per-question result into the app's Response (text the rubric runs against). */
export function responseFromResult(def: ItemDef | undefined, r: ApiItemResult): Response {
  const value = r.scored_data?.value;
  const base: Response = { questionId: String(r.item_id), text: "", canvasPoints: r.score ?? null, answered: false };
  const slug = def?.question.rawType ?? "";
  const label = (id: string) => def?.choiceText.get(id) ?? id;

  if (slug === "rich-fill-blank" || slug === "fill-blank") {
    const map = isRec(value) ? value : {};
    const order = def?.blankOrder.length ? def.blankOrder : Object.keys(map);
    const parts = order.map((id) => {
      const b = map[id];
      return isRec(b) && typeof b.user_response === "string" ? b.user_response : "";
    });
    return { ...base, parts, text: parts.join("\n"), answered: parts.some((p) => p.trim() !== "") };
  }
  if (slug === "ordering" && Array.isArray(value)) {
    // Per slot: user_responded = the chunk the student put there; value = the correct chunk.
    const slots = [...value].filter(isRec).sort((a, b) => Number(a.id) - Number(b.id));
    const picked = slots.map((s) => (typeof s.user_responded === "string" ? s.user_responded : ""));
    const correct = slots.map((s) => String(s.value ?? ""));
    const parts = picked.map(label);
    const orderIndex = picked.map((id) => (id ? correct.indexOf(id) : -1));
    return { ...base, parts, orderIndex, text: parts.join("\n\n"), answered: parts.length > 0 };
  }
  if (slug === "true-false" && isRec(value)) {
    const pick = Object.keys(value).find((k) => responded(value[k])) ?? "";
    return { ...base, text: pick, parts: pick ? [pick] : [], answered: !!pick };
  }
  if ((slug === "choice" || slug === "multi-answer") && isRec(value)) {
    const ids = Object.keys(value).filter((k) => responded(value[k]));
    const parts = ids.map(label);
    return { ...base, parts, text: parts.join("\n"), answered: ids.length > 0 };
  }
  if (typeof value === "string") {
    const text = htmlToText(value);
    return { ...base, text, raw: value !== text ? value : undefined, answered: text.trim() !== "" };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { ...base, text: String(value), answered: true };
  }
  if (value != null) {
    // Unknown structure: keep it visible and searchable rather than dropping it.
    const text = JSON.stringify(value);
    return { ...base, text, answered: text !== "{}" && text !== "[]" };
  }
  return base;
}

/** Accepted answers per blank, collected from the results (New Quizzes includes them). */
export function collectAnswerKey(def: ItemDef, results: ApiItemResult[]): string[][] | undefined {
  // Ordering: each slot's correct chunk is its `value`.
  if (def.question.rawType === "ordering") {
    for (const r of results) {
      const v = r.scored_data?.value;
      if (!Array.isArray(v)) continue;
      const slots = v.filter(isRec).sort((a, b) => Number(a.id) - Number(b.id));
      if (slots.length && slots.every((s) => typeof s.value === "string")) {
        return slots.map((s) => [def.choiceText.get(String(s.value)) ?? String(s.value)]);
      }
    }
    return undefined;
  }
  if (!def.blankOrder.length) return undefined;
  const sets = def.blankOrder.map(() => new Set<string>());
  for (const r of results) {
    const map = isRec(r.scored_data?.value) ? (r.scored_data!.value as Rec) : {};
    def.blankOrder.forEach((id, i) => {
      const b = map[id];
      if (!isRec(b)) return;
      const ca = b.correct_answer;
      for (const a of Array.isArray(ca) ? ca : ca != null ? [ca] : []) if (typeof a === "string") sets[i].add(a);
    });
  }
  return sets.some((s) => s.size) ? sets.map((s) => [...s]) : undefined;
}

/** participant_session_id from a Canvas LTI submission URL (possibly nested in a `url` param). */
export function participantSessionFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const direct = u.searchParams.get("participant_session_id");
    if (direct) return direct;
    const inner = u.searchParams.get("url");
    return inner ? participantSessionFromUrl(inner) : null;
  } catch {
    return null;
  }
}

// ---------- loading ----------

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function sortableName(name: string) {
  const p = name.trim().split(/\s+/);
  return p.length > 1 ? `${p[p.length - 1]}, ${p.slice(0, -1).join(" ")}` : name;
}

export interface LoadProgress { phase: string; done: number; total: number }

export async function loadNewQuizFromApi(courseId: string, assignmentId: string, title: string, onProgress: (p: LoadProgress) => void): Promise<QuizData> {
  onProgress({ phase: "Opening New Quizzes", done: 0, total: 0 });
  const info = await nqOpen(courseId, assignmentId);
  onProgress({ phase: "Listing students", done: 0, total: 0 });
  const participants = await nqLti<ApiParticipant[]>(info.key, `/api/assignments/${info.lti_assignment_id}/participants?per_page=50`, true);

  // The attempt to grade: the latest submitted one.
  const withAttempt = participants.flatMap((p) => {
    const submitted = (p.participant_sessions ?? []).filter((s) => s.submitted_at || ["graded", "submitted", "pending_review", "autograding_failed"].includes(s.status ?? ""));
    const latest = submitted.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")).pop();
    return latest ? [{ p, session: latest }] : [];
  });

  // New Quizzes' student list leaves out Canvas's Test Student (Student View). Canvas's submission
  // for anyone missing links to their attempt: …/lti/launch?participant_session_id=…
  const have = new Set(withAttempt.map((w) => String(w.p.canvas_user_id ?? "")));
  const subs = await listSubmissions(courseId, assignmentId, ["user"]).catch(() => []);
  for (const s of subs) {
    if (s.workflow_state === "unsubmitted" || have.has(String(s.user_id)) || !s.url) continue;
    const psid = participantSessionFromUrl(s.url);
    if (!psid) continue;
    withAttempt.push({
      p: { id: `canvas-${s.user_id}`, canvas_user_id: String(s.user_id), user: { full_name: s.user?.name } },
      session: { id: psid, submitted_at: s.submitted_at },
    });
  }

  const defs = new Map<string, ItemDef>();
  const notes: string[] = [];
  let done = 0;
  const loaded = await pool(withAttempt, 4, async ({ p, session }) => {
    const qsid = await nqAttempt(info.key, String(session.id));
    const qs = await nqQuiz<ApiQuizSession>(info.key, qsid, "GET", `/api/quiz_sessions/${qsid}`);
    const rid = qs.authoritative_result?.id;
    const results = rid == null ? [] : await nqQuiz<ApiItemResult[]>(info.key, qsid, "GET", `/api/quiz_sessions/${qsid}/results/${rid}/session_item_results`, undefined, true);
    // Question definitions: from the first attempt, plus any attempt with questions not seen yet (question banks).
    if (results.some((r) => !defs.has(String(r.item_id)))) {
      const items = await nqQuiz<ApiSessionItem[]>(info.key, qsid, "GET", `/api/quiz_sessions/${qsid}/session_items`, undefined, true);
      for (const [id, d] of defsFromSessionItems(items)) if (!defs.has(id)) defs.set(id, d);
    }
    onProgress({ phase: "Loading answers", done: ++done, total: withAttempt.length });
    return { p, session, qsid, qs, results };
  });

  const questions = [...defs.values()].map((d) => d.question).sort((a, b) => a.position - b.position);
  const allResults = loaded.flatMap((l) => l.results);
  for (const d of defs.values()) d.question.answerKey = collectAnswerKey(d, allResults.filter((r) => String(r.item_id) === d.question.id));
  // Label blanks with their first accepted answer, like the CSV report does.
  for (const d of defs.values()) {
    if (d.question.answerKey && d.blankOrder.length) d.question.blankIds = d.question.answerKey.map((a, i) => a[0] ?? `blank${i + 1}`);
  }
  if (new Set(loaded.map((l) => l.results.map((r) => r.item_id).sort().join())).size > 1) {
    notes.push("Students got different sets of questions (question banks or groups). Questions a student didn't get are left blank for them and never graded.");
  }

  const students: Student[] = loaded.map(({ p, session, qsid, qs, results }) => {
    const responses: Record<string, Response> = {};
    for (const r of results) responses[String(r.item_id)] = responseFromResult(defs.get(String(r.item_id)), r);
    const name = p.user?.full_name ?? `Student ${p.canvas_user_id ?? p.id}`;
    return {
      userId: String(p.canvas_user_id ?? p.id),
      name,
      sortableName: sortableName(name),
      attempt: qs.attempt ?? null,
      canvasScore: qs.authoritative_result?.score ?? null,
      submittedAt: qs.submitted_at ?? session.submitted_at ?? null,
      nq: { participantSessionId: String(session.id), quizSessionId: qsid },
      responses,
    };
  });
  students.sort((a, b) => a.sortableName.localeCompare(b.sortableName));
  if (info.read_only) notes.push("New Quizzes reports this quiz as read-only (for example, the course has concluded). You can review and export, but not send.");

  return {
    source: "new_quizzes_api",
    title: info.title ?? title,
    courseId,
    assignmentId,
    pointsPossible: questions.reduce((s, q) => s + (q.pointsPossible ?? 0), 0) || null,
    postManually: null,
    questions,
    students,
    notes,
    nqKey: info.key,
    readOnly: info.read_only,
  };
}
