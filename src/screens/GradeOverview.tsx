// Grade mode: load a rubric someone else wrote, see what it does, review, send.

import type { ReactNode } from "react";
import { describeSpec, type Problem } from "../lib/rubric";
import { truncate } from "../lib/text";
import type { QuizData } from "../lib/types";
import { ErrorNote, Spinner } from "../components/ui";
import type { RubricState, WorkspaceCtx } from "./Workspace";

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Grade mode before a rubric is loaded. */
export function RubricPicker({ quiz, rubric }: { quiz: QuizData; rubric: RubricState }) {
  return (
    <div className="center-page">
      <div className="inner narrow">
        <div>
          <h1>Load the rubric</h1>
          <div className="muted">{quiz.title} · {quiz.students.length} submissions · {quiz.questions.length} questions</div>
        </div>
        <div className="card pad col" style={{ gap: 12 }}>
          <p style={{ margin: 0 }}>
            Choose the rubric file (<span className="mono">.yaml</span>) for this quiz. Whoever wrote the rubric can send it to you,
            or put it in a shared folder.
          </p>
          <p className="muted small" style={{ margin: 0 }}>
            The rubric only regrades the questions it lists. You'll see every change and can adjust any score before anything goes to Canvas.
          </p>
          <ErrorNote error={rubric.loadError} />
          <div className="row">
            <button className="btn primary" onClick={rubric.choose} disabled={rubric.loading}>
              {rubric.loading ? <Spinner /> : null} Choose rubric file…
            </button>
          </div>
        </div>
        <p className="faint small">Writing rubrics? Switch to <b>Edit rubrics</b> in the top bar.</p>
      </div>
    </div>
  );
}

/** Rubric keys that point at questions not in this quiz. */
function unmatched(rubric: RubricState, quiz: QuizData): { total: number; missing: number; idKeys: number; idMissing: number } {
  const keys = rubric.parsed.rubric?.questionKeys ?? [];
  const ids = new Set(quiz.questions.map((q) => q.id));
  let missing = 0, idKeys = 0, idMissing = 0;
  for (const k of keys) {
    const pos = /^(?:q|#)\s*(\d+)$/i.exec(k.trim());
    const ok = ids.has(k.trim()) || (pos != null && Number(pos[1]) >= 1 && Number(pos[1]) <= quiz.questions.length);
    if (!pos) { idKeys++; if (!ok) idMissing++; }
    if (!ok) missing++;
  }
  return { total: keys.length, missing, idKeys, idMissing };
}

function ProblemList({ problems }: { problems: Problem[] }) {
  return (
    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} className="small">
      {problems.map((p, i) => <li key={i}>{p.line ? <span className="mono faint">line {p.line}: </span> : null}{p.message}</li>)}
    </ul>
  );
}

export function GradeOverview({ ctx, rubric, canSend, sendTitle, onSend, onExport }: {
  ctx: WorkspaceCtx;
  rubric: RubricState;
  canSend: boolean;
  sendTitle: string;
  onSend: () => void;
  onExport: () => void;
}) {
  const { quiz, specs, results, reviewed, goTo } = ctx;
  const r = rubric.parsed.rubric;
  const errors = rubric.problems.filter((p) => p.level === "error");
  const warnings = rubric.problems.filter((p) => p.level === "warning");
  const um = unmatched(rubric, quiz);
  const wrongQuiz = um.idKeys > 0 && um.idMissing === um.idKeys;

  const all = [...results.values()];
  const changed = all.filter((x) => x.changed).length;
  const flagged = all.filter((x) => x.flagged);
  const flaggedNotReviewed = flagged.filter((x) => !reviewed.has(x.userId));
  const graded = quiz.questions.filter((q) => specs.has(q.id));
  const firstFlagged = quiz.students.find((s) => flaggedNotReviewed.some((f) => f.userId === s.userId));
  const firstUnreviewed = quiz.students.find((s) => !reviewed.has(s.userId) && results.get(s.userId)?.changed);

  return (
    <div className="pane grow">
      <div className="pane-body">
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "20px 20px 40px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* rubric */}
          <div className="card pad col" style={{ gap: 10 }}>
            <div className="row">
              <div className="grow">
                <div className="muted small">Rubric</div>
                <h2>{r?.title || (rubric.path ? fileName(rubric.path) : "Unsaved rubric")}</h2>
                {rubric.path && <div className="faint small mono" title={rubric.path}>{fileName(rubric.path)}</div>}
                {!rubric.path && <div className="small" style={{ color: "var(--warn)" }}>Unsaved draft from Edit rubrics mode</div>}
              </div>
              {rubric.path && <button className="btn" onClick={rubric.reload} disabled={rubric.loading} title="Re-read the file, e.g. after the author updated it">{rubric.loading ? <Spinner /> : null} Reload</button>}
              <button className="btn" onClick={rubric.choose}>Choose a different rubric…</button>
            </div>
            <ErrorNote error={rubric.loadError} />
            {r?.notes && (
              <div className="notice info" style={{ whiteSpace: "pre-wrap" }}>
                <div className="small muted" style={{ marginBottom: 2 }}>Notes from the rubric author</div>
                {r.notes}
              </div>
            )}
            {errors.length > 0 && (
              <div className="notice bad">
                <b>This rubric file has mistakes, so it can't be used to send grades.</b> Pass these messages on to whoever wrote it:
                <ProblemList problems={errors} />
              </div>
            )}
            {wrongQuiz ? (
              <div className="notice bad"><b>This rubric looks like it's for a different quiz.</b> None of the question IDs it lists are in <i>{quiz.title}</i>. Check you picked the right file.</div>
            ) : um.missing > 0 ? (
              <div className="notice warn small">{um.missing} of the {um.total} questions this rubric lists aren't in this quiz and will be ignored. If that's unexpected, check you picked the right rubric.</div>
            ) : null}
            {errors.length === 0 && warnings.length > 0 && !wrongQuiz && (
              <details className="small muted">
                <summary>{warnings.length} note{warnings.length === 1 ? "" : "s"} about the rubric file</summary>
                <ProblemList problems={warnings} />
              </details>
            )}
          </div>

          {/* next steps */}
          <div className="card pad col" style={{ gap: 12 }}>
            <h3>What to do</h3>
            <Step n={1} done={flaggedNotReviewed.length === 0}
              title={flagged.length ? `Check the ${flagged.length} submission${flagged.length === 1 ? "" : "s"} that need review` : "No submissions were flagged for review"}
              detail={flagged.length ? "The rubric couldn't decide these on its own, or the author asked for a person to look. Adjust the score if needed, then mark them reviewed." : undefined}
              action={firstFlagged && <button className="btn primary" onClick={() => goTo("review", { userId: firstFlagged.userId })}>Review flagged</button>} />
            <Step n={2} done={changed > 0 && all.filter((x) => x.changed).every((x) => reviewed.has(x.userId))}
              title={`Look over the ${changed} regraded submission${changed === 1 ? "" : "s"}`}
              detail={`${reviewed.size} of ${quiz.students.length} marked reviewed. Use j / k to move between students and r to mark reviewed.`}
              action={firstUnreviewed && <button className="btn" onClick={() => goTo("review", { userId: firstUnreviewed.userId })}>Continue reviewing</button>} />
            <Step n={3} done={false}
              title="Send the new grades to Canvas"
              detail={quiz.source === "new_quizzes_csv"
                ? "For New Quizzes this updates each student's total score. Grades stay hidden until you post them in Canvas."
                : "Updates only the regraded questions. Grades stay hidden until you post them in Canvas."}
              action={<div className="row">
                <button className="btn" onClick={onExport}>Export CSV</button>
                <button className="btn primary" disabled={!canSend} title={sendTitle} onClick={onSend}>Send to Canvas…</button>
              </div>} />
          </div>

          {/* what it grades */}
          <div className="card">
            <div className="row" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
              <h3 className="grow">What this rubric regrades</h3>
              <span className="muted small">{graded.length} of {quiz.questions.length} questions. The other {quiz.questions.length - graded.length} keep their Canvas scores.</span>
            </div>
            <table className="grid">
              <thead><tr><th>Question</th><th>How it's graded</th><th className="right">Regraded</th><th className="right">Need review</th></tr></thead>
              <tbody>
                {graded.map((q) => {
                  const spec = specs.get(q.id)!;
                  let ch = 0, fl = 0;
                  for (const x of all) { const c = x.cells[q.id]; if (c.changed && c.status !== "untouched" && c.status !== "kept") ch++; if (c.flags.length) fl++; }
                  return (
                    <tr key={q.id}>
                      <td style={{ maxWidth: 380 }}>
                        <b>Q{q.position}</b> <span className="muted">{truncate(q.text.replace(/\s+/g, " "), 90)}</span>
                        {spec.note && <div className="small" style={{ marginTop: 3 }}><span className="muted">Author: </span>{spec.note}</div>}
                      </td>
                      <td className="small">{describeSpec(spec)}</td>
                      <td className="right num">{ch || <span className="faint">0</span>}</td>
                      <td className="right num" style={fl ? { color: "var(--warn)", fontWeight: 600 } : undefined}>{fl || <span className="faint">0</span>}</td>
                    </tr>
                  );
                })}
                {graded.length === 0 && <tr><td colSpan={4} className="muted">This rubric doesn't regrade any questions in this quiz.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, done, title, detail, action }: { n: number; done: boolean; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
      <span style={{
        width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: 600, background: done ? "var(--good-soft)" : "var(--accent-soft)", color: done ? "var(--good)" : "var(--accent)",
      }}>{done ? "✓" : n}</span>
      <div className="grow">
        <div style={{ fontWeight: 500 }}>{title}</div>
        {detail && <div className="muted small">{detail}</div>}
      </div>
      {action}
    </div>
  );
}
