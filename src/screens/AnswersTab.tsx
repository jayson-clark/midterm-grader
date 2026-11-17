import { Fragment, useEffect, useMemo, useState } from "react";
import { answerGroups } from "../lib/grader";
import { looseRegex } from "../lib/template";
import { truncate } from "../lib/text";
import { fmt } from "../components/ui";
import type { WorkspaceCtx } from "./Workspace";

/** Every distinct answer to a question (or blank), how many gave it, and how the rubric scores it. */
export function AnswersTab({ ctx, questionId, setQuestionId }: { ctx: WorkspaceCtx; questionId?: string; setQuestionId: (id: string) => void }) {
  const { quiz, specs, results } = ctx;
  const q = quiz.questions.find((x) => x.id === questionId) ?? quiz.questions[0];
  const [blank, setBlank] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const hasBlanks = (q.kind === "fill_blank" || q.kind === "dropdown") && q.blankIds.length > 1;

  useEffect(() => { setBlank(hasBlanks ? 0 : null); setOpen(null); setPromptOpen(false); }, [q.id, hasBlanks]);

  const groups = useMemo(() => answerGroups(quiz, results, q.id, hasBlanks ? blank : null), [quiz, results, q.id, blank, hasBlanks]);
  const names = useMemo(() => new Map(quiz.students.map((s) => [s.userId, s.name])), [quiz.students]);
  const spec = specs.get(q.id);
  const graded = spec && !spec.keep;
  const blankMax = hasBlanks && blank != null ? results.values().next().value?.cells[q.id]?.parts?.[blank]?.max : null;

  function copyRegex(text: string) {
    const r = `'${looseRegex(text).replace(/'/g, "''")}'`;
    void navigator.clipboard.writeText(r);
    setCopied(text);
    setTimeout(() => setCopied(null), 1200);
  }

  return (
    <>
      <div className="pane sidebar">
        <div className="pane-head"><h3>Questions</h3></div>
        <div className="pane-body">
          {quiz.questions.map((x) => {
            const s = specs.get(x.id);
            return (
              <div key={x.id} className={`qrow ${x.id === q.id ? "active" : ""}`} onClick={() => setQuestionId(x.id)}>
                <span className="qnum">Q{x.position}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="qtext">{truncate(x.text.replace(/\s+/g, " "), 60)}</div>
                  <div className="row small muted" style={{ gap: 6 }}>
                    <span className={`dot ${!s ? "" : s.keep ? "kept" : "graded"}`} /> {x.kind}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pane grow">
        <div className="pane-head" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6, padding: "10px 16px" }}>
          <div className="row" style={{ width: "100%" }}>
            <h2>Q{q.position}</h2>
            <span className="badge">{q.kind}{q.rawType !== q.kind ? ` · ${q.rawType}` : ""}</span>
            <span className="badge">{q.pointsPossible ?? "?"} pts{q.pointsSource === "inferred" ? " (inferred)" : ""}</span>
            <span className="badge mono">id {q.id}</span>
            {spec ? <span className="badge accent mono">{spec.keep ? "use: canvas" : spec.origin}</span> : <span className="badge">not in rubric: Canvas scores stand</span>}
            <span className="spacer" />
            <button className="btn sm" onClick={() => ctx.goTo("rubric")}>Edit rubric</button>
          </div>
          <div className={`prompt ${promptOpen ? "open" : ""}`} onClick={() => setPromptOpen(!promptOpen)} title="Click to expand">{q.text}</div>
          {hasBlanks && (
            <div className="seg">
              {q.blankIds.map((b, i) => (
                <button key={i} className={blank === i ? "on" : ""} onClick={() => setBlank(i)} title={b}>
                  {i + 1}{/^blank\d*$/.test(b) ? "" : `: ${truncate(b, 18)}`}
                </button>
              ))}
              <button className={blank == null ? "on" : ""} onClick={() => setBlank(null)}>whole</button>
            </div>
          )}
        </div>
        <div className="pane-body">
          <table className="grid">
            <thead>
              <tr>
                <th>{hasBlanks && blank != null ? `Blank ${blank + 1} answer` : "Answer"}</th>
                <th className="right">Students</th>
                <th className="right">{graded ? "Rubric score" : "Score"}{blankMax != null ? ` / ${fmt(blankMax)}` : ""}</th>
                {(!hasBlanks || blank == null) && <th className="right">Canvas</th>}
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const scores = [...new Set(g.scores.map((v) => fmt(v)))];
                const canvas = [...new Set(g.canvas.map((v) => fmt(v)))];
                const differs = graded && (!hasBlanks || blank == null) && g.scores.some((v, i) => g.canvas[i] == null || Math.abs(v - (g.canvas[i] ?? 0)) > 1e-3);
                return (
                  <Fragment key={g.text}>
                    <tr className={`click ${g.flagged ? "cell-flag" : ""}`} onClick={() => setOpen(open === g.text ? null : g.text)}>
                      <td className="answer-text" style={{ maxWidth: 520 }}>{g.text ? truncate(g.text, 400) : <span className="faint">(blank)</span>}</td>
                      <td className="right num">{g.students.length}</td>
                      <td className="right num" style={differs ? { color: "var(--accent)", fontWeight: 600 } : undefined}>{scores.join(", ")}</td>
                      {(!hasBlanks || blank == null) && <td className="right num faint">{canvas.join(", ")}</td>}
                      <td className="small muted" style={{ maxWidth: 320 }}>{graded ? truncate(g.matched, 160) : ""}</td>
                      <td className="right">
                        {g.text && !(hasBlanks && blank == null) && (q.kind === "fill_blank" || q.kind === "dropdown" || q.kind === "choice" || q.kind === "numeric") && (
                          <button className="btn sm ghost" title="Copy a regex that matches this answer" onClick={(e) => { e.stopPropagation(); copyRegex(g.text); }}>
                            {copied === g.text ? "Copied" : "Copy regex"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === g.text && (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--panel-2)" }}>
                          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                            {g.students.map((id) => (
                              <button key={id} className="btn sm" onClick={() => ctx.goTo("review", { userId: id })}>{names.get(id)}</button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
