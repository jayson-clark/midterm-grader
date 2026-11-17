import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "../lib/canvas";
import { gradeAll, overrideKey, type Override, type Overrides, type StudentResult } from "../lib/grader";
import { parseRubric, resolveSpecs, type Problem, type QuestionSpec } from "../lib/rubric";
import { toCsv } from "../lib/text";
import type { QuizData } from "../lib/types";
import { fmt, ScoreChange } from "../components/ui";
import { RubricTab } from "./RubricTab";
import { AnswersTab } from "./AnswersTab";
import { ReviewTab } from "./ReviewTab";
import { SendDialog } from "./SendDialog";

export type Tab = "rubric" | "answers" | "review" | "gradebook";

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

export function Workspace({ quiz }: { quiz: QuizData }) {
  const saved = useMemo(() => load(quiz), [quiz]);
  const [tab, setTab] = useState<Tab>("rubric");
  const [rubricText, setRubricText] = useState(saved.rubricText ?? STARTER);
  const [rubricPath, setRubricPath] = useState<string | null>(saved.rubricPath ?? null);
  const [savedText, setSavedText] = useState<string | null>(saved.rubricPath ? (saved.rubricText ?? null) : null);
  const [overrides, setOverrides] = useState<Overrides>(saved.overrides ?? {});
  const [reviewed, setReviewedSet] = useState<Set<string>>(new Set(saved.reviewed ?? []));
  const [sel, setSel] = useState<{ questionId?: string; userId?: string }>({});
  const [sending, setSending] = useState(false);

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
    () => (parsed.rubric ? resolveSpecs(parsed.rubric, quiz.questions) : { specs: new Map<string, QuestionSpec>(), problems: [] as Problem[] }),
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
  const canSend = !!quiz.courseId && !!quiz.assignmentId && !hasErrors && changed > 0;

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

  return (
    <div className="main">
      <div className="ws-head">
        <div className="tabs">
          {(["rubric", "answers", "review", "gradebook"] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t === "rubric" ? "Rubric" : t === "answers" ? "Answers" : t === "review" ? "Review" : "Gradebook"}
              {t === "rubric" && hasErrors && <span className="dot flag" />}
              {t === "review" && <span className="faint small">{reviewed.size}/{quiz.students.length}</span>}
            </button>
          ))}
        </div>
        <div className="stats">
          <span><b>{quiz.students.length}</b> students</span>
          <span><b>{graded}</b>/{quiz.questions.length} questions in rubric</span>
          <span><b>{changed}</b> regraded</span>
          {flagged > 0 && <span style={{ color: "var(--warn)" }}><b style={{ color: "inherit" }}>{flagged}</b> need review</span>}
          <span>avg <ScoreChange from={avg("canvasScore")} to={avg("newScore")} /></span>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={exportCsv}>Export CSV</button>
        <button className="btn primary" disabled={!canSend} onClick={() => setSending(true)}
          title={!quiz.courseId ? "Offline: not connected to a Canvas assignment" : hasErrors ? "Fix rubric errors first" : changed === 0 ? "Nothing to send" : ""}>
          Send to Canvas…
        </button>
      </div>
      <div className="ws-body">
        {tab === "rubric" && (
          <RubricTab ctx={ctx} text={rubricText} setText={setRubricText} path={rubricPath} setPath={setRubricPath}
            dirty={savedText !== rubricText} markSaved={setSavedText} problems={[...parsed.problems, ...resolved.problems]} />
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
        <table className="grid">
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
