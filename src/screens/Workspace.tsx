import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../lib/canvas";
import { gradeAll, overrideKey, type Override, type Overrides, type StudentResult } from "../lib/grader";
import { parseRubric, resolveSpecs, type ParseResult, type Problem, type QuestionSpec, type Resolved } from "../lib/rubric";
import { toCsv } from "../lib/text";
import type { QuizData } from "../lib/types";
import { fmt, ScoreChange } from "../components/ui";
import { RubricTab } from "./RubricTab";
import { AnswersTab } from "./AnswersTab";
import { ReviewTab } from "./ReviewTab";
import { SendDialog } from "./SendDialog";
import { GradeOverview, RubricPicker } from "./GradeOverview";

export type Mode = "grade" | "author";
export type Tab = "overview" | "rubric" | "answers" | "review" | "gradebook";

const TABS: Record<Mode, Tab[]> = {
  grade: ["overview", "review", "gradebook"],
  author: ["rubric", "answers", "review", "gradebook"],
};
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", rubric: "Rubric", answers: "Answers", review: "Review", gradebook: "Gradebook" };

export interface WorkspaceCtx {
  quiz: QuizData;
  specs: Map<string, QuestionSpec>;
  results: Map<string, StudentResult>;
  overrides: Overrides;
  setOverride: (userId: string, questionId: string, o: Override | null) => void;
  reviewed: Set<string>;
  setReviewed: (userId: string, on: boolean) => void;
  goTo: (tab: Tab, sel?: { questionId?: string; userId?: string }) => void;
}

interface Saved {
  rubricText?: string;
  rubricPath?: string | null;
  overrides?: Overrides;
  reviewed?: string[];
}

function storageKey(q: QuizData) {
  return `mg:${q.source}:${q.assignmentId ?? q.title}`;
}
function load(q: QuizData): Saved {
  try { return JSON.parse(localStorage.getItem(storageKey(q)) ?? "{}"); } catch { return {}; }
}

const STARTER = `# No rubric loaded yet. Use "New from quiz" to generate one with every question listed,
# or "Open…" to load a rubric file. Format reference: RUBRIC.md

version: 1
questions:
`;

export interface RubricState {
  text: string;
  path: string | null;
  parsed: ParseResult;
  problems: Problem[];
  /** rubric key -> matched question id (null: matches nothing in this quiz) */
  keyMatches: Map<string, string | null>;
  hasErrors: boolean;
  /** draft differs from the file on disk */
  dirty: boolean;
  loading: boolean;
  loadError: string | null;
  choose: () => Promise<void>;
  reload: () => Promise<void>;
}

export function Workspace({ quiz, mode }: { quiz: QuizData; mode: Mode }) {
  const saved = useMemo(() => load(quiz), [quiz]);
  const [tab, setTab] = useState<Tab>(mode === "grade" ? "overview" : "rubric");
  const [rubricText, setRubricText] = useState(saved.rubricText ?? STARTER);
  const [rubricPath, setRubricPath] = useState<string | null>(saved.rubricPath ?? null);
  const [savedText, setSavedText] = useState<string | null>(saved.rubricPath ? (saved.rubricText ?? null) : null);
  const [overrides, setOverrides] = useState<Overrides>(saved.overrides ?? {});
  const [reviewed, setReviewedSet] = useState<Set<string>>(new Set(saved.reviewed ?? []));
  const [sel, setSel] = useState<{ questionId?: string; userId?: string }>({});
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const readRubric = useCallback(async (p: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const t = await readTextFile(p);
      setRubricText(t); setRubricPath(p); setSavedText(t);
    } catch (e) {
      setLoadError(`Couldn't open ${p.split(/[\\/]/).pop()}: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);
  const chooseRubric = useCallback(async () => {
    const p = await open({ multiple: false, filters: [{ name: "Rubric", extensions: ["yaml", "yml"] }] });
    if (p && !Array.isArray(p)) await readRubric(p);
  }, [readRubric]);
  const reloadRubric = useCallback(async () => { if (rubricPath) await readRubric(rubricPath); }, [rubricPath, readRubric]);

  // Graders always use the rubric file as it is on disk now, so an updated file is picked up.
  useEffect(() => {
    if (mode === "grade" && rubricPath) void readRubric(rubricPath);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!TABS[mode].includes(tab)) setTab(mode === "grade" ? "overview" : "rubric");
  }, [mode, tab]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(storageKey(quiz), JSON.stringify({ rubricText, rubricPath, overrides, reviewed: [...reviewed] } satisfies Saved));
      } catch { /* storage full or blocked: not fatal */ }
    }, 300);
    return () => clearTimeout(t);
  }, [quiz, rubricText, rubricPath, overrides, reviewed]);

  const deferred = useDeferredValue(rubricText);
  const parsed = useMemo(() => parseRubric(deferred), [deferred]);
  const resolved = useMemo(
    () => (parsed.rubric ? resolveSpecs(parsed.rubric, quiz.questions) : { specs: new Map(), problems: [], keyMatches: new Map() } satisfies Resolved),
    [parsed, quiz.questions],
  );
  const hasErrors = parsed.problems.some((p) => p.level === "error") || resolved.problems.some((p) => p.level === "error");
  const results = useMemo(() => gradeAll(quiz, resolved.specs, overrides), [quiz, resolved.specs, overrides]);

  const setOverride = useCallback((userId: string, questionId: string, o: Override | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (o == null || (o.score == null && o.comment == null)) delete next[overrideKey(userId, questionId)];
      else next[overrideKey(userId, questionId)] = o;
      return next;
    });
  }, []);
  const setReviewed = useCallback((userId: string, on: boolean) => {
    setReviewedSet((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId); else next.delete(userId);
      return next;
    });
  }, []);
  const goTo = useCallback((t: Tab, s?: { questionId?: string; userId?: string }) => {
    if (s) setSel((prev) => ({ ...prev, ...s }));
    setTab(t);
  }, []);

  const ctx: WorkspaceCtx = { quiz, specs: resolved.specs, results, overrides, setOverride, reviewed, setReviewed, goTo };

  const all = [...results.values()];
  const changed = all.filter((r) => r.changed).length;
  const flagged = all.filter((r) => r.flagged).length;
  const graded = [...resolved.specs.values()].filter((s) => !s.keep).length;
  const avg = (k: "canvasScore" | "newScore") => {
    const v = all.map((r) => r[k]).filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const hasComments = all.some((r) => Object.values(r.cells).some((c) => (c.status === "graded" || c.status === "override") && c.comments.length > 0));
  const canSend = !!quiz.courseId && !!quiz.assignmentId && !quiz.readOnly && !hasErrors && (changed > 0 || hasComments);

  async function exportCsv() {
    const p = await save({ defaultPath: `${quiz.title.replace(/[^\w.-]+/g, "_")}_grades.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!p) return;
    const qs = quiz.questions.filter((q) => resolved.specs.has(q.id) || quiz.students.some((s) => overrides[overrideKey(s.userId, q.id)]));
    const header = ["Name", "Canvas user ID", "Section", "Canvas total", "New total", "Change", "Reviewed", "Flags",
      ...qs.flatMap((q) => [`Q${q.position} Canvas`, `Q${q.position} New`, `Q${q.position} Comment`])];
    const rows = quiz.students.map((s) => {
      const r = results.get(s.userId)!;
      return [
        s.name, s.userId, s.section ?? "", fmt(r.canvasScore, 4), fmt(r.newScore, 4),
        r.canvasScore != null && r.newScore != null ? fmt(r.newScore - r.canvasScore, 4) : "",
        reviewed.has(s.userId) ? "yes" : "",
        Object.values(r.cells).flatMap((c) => c.flags.map((f) => `Q${quiz.questions.find((q) => q.id === c.questionId)?.position}: ${f}`)).join("; "),
        ...qs.flatMap((q) => { const c = r.cells[q.id]; return [fmt(c.canvasPoints, 4), fmt(c.score, 4), c.comments.join(" ")]; }),
      ];
    });
    await writeTextFile(p, toCsv([header, ...rows]));
  }

  const problems = [...parsed.problems, ...resolved.problems];
  const rubric: RubricState = {
    text: rubricText, path: rubricPath, parsed, problems, keyMatches: resolved.keyMatches, hasErrors,
    dirty: savedText !== rubricText, loading, loadError, choose: chooseRubric, reload: reloadRubric,
  };
  const needsRubric = mode === "grade" && !rubricPath && resolved.specs.size === 0;
  const sendTitle = !quiz.courseId ? "Offline: not connected to a Canvas assignment" : quiz.readOnly ? "New Quizzes reports this quiz as read-only" : hasErrors ? "The rubric has errors" : changed === 0 && !hasComments ? "Nothing to send" : "";

  if (needsRubric) {
    return <div className="main"><RubricPicker quiz={quiz} rubric={rubric} /></div>;
  }

  return (
    <div className="main">
      <div className="ws-head">
        <div className="tabs">
          {TABS[mode].map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
              {(t === "rubric" || t === "overview") && hasErrors && <span className="dot flag" />}
              {t === "review" && <span className="count num" title={`${reviewed.size} of ${quiz.students.length} students marked reviewed`}>{reviewed.size}/{quiz.students.length}</span>}
            </button>
          ))}
        </div>
        <div className="stats">
          <div className="stat"><b>{quiz.students.length}</b><span className="lbl">students</span></div>
          <div className="stat" title={`The rubric regrades ${graded} of this quiz's ${quiz.questions.length} questions`}><b>{graded}<span className="of"> / {quiz.questions.length}</span></b><span className="lbl">questions in rubric</span></div>
          <div className="stat"><b>{changed}</b><span className="lbl">regraded</span></div>
          {flagged > 0 && <div className="stat warn"><b>{flagged}</b><span className="lbl">need review</span></div>}
          <div className="stat" title="Average total score: Canvas now, then with the rubric applied"><b><ScoreChange from={avg("canvasScore")} to={avg("newScore")} /></b><span className="lbl">average score</span></div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={exportCsv}>Export CSV</button>
        <button className="btn primary" disabled={!canSend} onClick={() => setSending(true)} title={sendTitle}>
          Send to Canvas…
        </button>
      </div>
      <div className="ws-body">
        {tab === "overview" && (
          <GradeOverview ctx={ctx} rubric={rubric} canSend={canSend} sendTitle={sendTitle} onSend={() => setSending(true)} onExport={exportCsv} />
        )}
        {tab === "rubric" && (
          <RubricTab ctx={ctx} text={rubricText} setText={setRubricText} path={rubricPath} setPath={setRubricPath}
            dirty={savedText !== rubricText} markSaved={setSavedText} problems={problems} />
        )}
        {tab === "answers" && <AnswersTab ctx={ctx} questionId={sel.questionId} setQuestionId={(id) => setSel((s) => ({ ...s, questionId: id }))} />}
        {tab === "review" && <ReviewTab ctx={ctx} userId={sel.userId} setUserId={(id) => setSel((s) => ({ ...s, userId: id }))} />}
        {tab === "gradebook" && <Gradebook ctx={ctx} />}
      </div>
      {sending && <SendDialog ctx={ctx} onClose={() => setSending(false)} />}
    </div>
  );
}

function Gradebook({ ctx }: { ctx: WorkspaceCtx }) {
  const { quiz, results, specs, reviewed, goTo, overrides } = ctx;
  const [onlyRubric, setOnlyRubric] = useState(true);
  const [filter, setFilter] = useState<"all" | "changed" | "flagged">("all");
  const qs = quiz.questions.filter((q) => !onlyRubric || specs.has(q.id) || quiz.students.some((s) => overrides[overrideKey(s.userId, q.id)]));
  const students = quiz.students.filter((s) => {
    const r = results.get(s.userId)!;
    return filter === "all" || (filter === "changed" ? r.changed : r.flagged);
  });
  return (
    <div className="pane grow">
      <div className="pane-head">
        <div className="seg">
          {(["all", "changed", "flagged"] as const).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "changed" ? "Regraded" : "Needs review"}</button>
          ))}
        </div>
        <label className="row small muted"><input type="checkbox" checked={onlyRubric} onChange={(e) => setOnlyRubric(e.target.checked)} /> Only rubric questions</label>
      </div>
      <div className="pane-body">
        <table className="grid fit">
          <thead>
            <tr>
              <th className="sticky">Student</th>
              <th className="right">Total</th>
              {qs.map((q) => <th key={q.id} className="right" title={q.text.slice(0, 200)}>Q{q.position}</th>)}
            </tr>
          </thead>
          <tbody>
            {students.map((s) => {
              const r = results.get(s.userId)!;
              return (
                <tr key={s.userId} className="click" onClick={() => goTo("review", { userId: s.userId })}>
                  <td className="sticky nowrap">
                    <span className="check">{reviewed.has(s.userId) ? "✓" : ""}</span> {s.sortableName}
                  </td>
                  <td className="right"><ScoreChange from={r.canvasScore} to={r.newScore} /></td>
                  {qs.map((q) => {
                    const c = r.cells[q.id];
                    return (
                      <td key={q.id} className={`right ${c.flags.length ? "cell-flag" : ""}`} title={[...c.matched, ...c.flags].join("\n")}>
                        {c.status === "untouched" || c.status === "kept" ? <span className="faint">{fmt(c.score)}</span> : <ScoreChange from={c.canvasPoints} to={c.score} />}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {students.length === 0 && <div className="empty-state">No students match.</div>}
      </div>
    </div>
  );
}
