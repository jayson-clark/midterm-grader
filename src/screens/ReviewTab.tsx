import { useEffect, useMemo, useRef, useState } from "react";
import { overrideKey, type Cell } from "../lib/grader";
import type { Question, Response, Student } from "../lib/types";
import { fmt, ReviewMark, ScoreChange, StatusBadge, staleLabel } from "../components/ui";
import type { StaleQuestion } from "../lib/review";
import type { WorkspaceCtx } from "./Workspace";

type Filter = "all" | "changed" | "flagged" | "todo";

/** Per-submission review: one student at a time, every rubric question with the why. */
export function ReviewTab({ ctx, userId, setUserId }: { ctx: WorkspaceCtx; userId?: string; setUserId: (id: string) => void }) {
  const { quiz, results, reviewed, stale, setReviewed } = ctx;
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => quiz.students.filter((s) => {
    const r = results.get(s.userId)!;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "changed") return r.changed;
    if (filter === "flagged") return r.flagged;
    if (filter === "todo") return !reviewed.has(s.userId);
    return true;
  }), [quiz.students, results, filter, search, reviewed]);

  const student = quiz.students.find((s) => s.userId === userId) ?? list[0] ?? quiz.students[0];
  const idx = list.findIndex((s) => s.userId === student?.userId);

  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [student?.userId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "j" || e.key === "ArrowDown") { const n = list[idx + 1]; if (n) { e.preventDefault(); setUserId(n.userId); } }
      if (e.key === "k" || e.key === "ArrowUp") { const p = list[idx - 1]; if (p) { e.preventDefault(); setUserId(p.userId); } }
      if (e.key === "r" && student) { e.preventDefault(); setReviewed(student.userId, !reviewed.has(student.userId)); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, idx, student, reviewed, setReviewed, setUserId]);

  if (!student) return <div className="empty-state grow">No submissions.</div>;
  const r = results.get(student.userId)!;
  const staleQs = stale.get(student.userId) ?? [];
  const staleById = new Map(staleQs.map((x) => [x.questionId, x]));
  const shown = quiz.questions.filter((q) => showAll || r.cells[q.id].status !== "untouched" || staleById.has(q.id));
  const hiddenCount = quiz.questions.length - shown.length;

  function markAndNext() {
    setReviewed(student.userId, true);
    const next = list.slice(idx + 1).find((s) => !reviewed.has(s.userId) && s.userId !== student.userId);
    if (next) setUserId(next.userId);
  }

  return (
    <>
      <div className="pane sidebar">
        <div className="pane-head stack">
          <input type="search" placeholder="Search students" aria-label="Search students" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="seg fill">
            {(["all", "changed", "flagged", "todo"] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "changed" ? "Regraded" : f === "flagged" ? "Flagged" : "To review"}
              </button>
            ))}
          </div>
        </div>
        <div className="pane-body">
          {list.map((s) => {
            const sr = results.get(s.userId)!;
            return (
              <div key={s.userId} className={`student-row ${s.userId === student.userId ? "active" : ""}`} onClick={() => setUserId(s.userId)}>
                <ReviewMark ctx={ctx} userId={s.userId} />
                <span className="grow ellipsis">{s.sortableName}</span>
                {sr.flagged && <span className="dot flag" title="needs review" />}
                <ScoreChange from={sr.canvasScore} to={sr.newScore} />
              </div>
            );
          })}
          {list.length === 0 && <div className="empty-state small">No students match.</div>}
        </div>
        <div className="pane-foot">
          <span><kbd>j</kbd> <kbd>k</kbd> next / previous</span>
          <span><kbd>r</kbd> mark reviewed</span>
        </div>
      </div>

      <div className="pane grow">
        <div className="pane-head roomy">
          <div className="grow">
            <h2>{student.name}</h2>
            <div className="muted small">
              {student.section ? `${student.section} · ` : ""}Canvas ID {student.userId}
              {student.attempt != null ? ` · attempt ${student.attempt}` : ""}
              {student.submittedAt ? ` · submitted ${student.submittedAt}` : ""}
            </div>
          </div>
          <div className="col" style={{ alignItems: "flex-end", gap: 2 }}>
            <span className="score big"><ScoreChange from={r.canvasScore} to={r.newScore} max={quiz.pointsPossible} /></span>
            <span className="muted small">{idx >= 0 ? `Student ${idx + 1} of ${list.length}` : "Not in the filtered list"}</span>
          </div>
          <button className="btn icon" disabled={idx <= 0} onClick={() => setUserId(list[idx - 1].userId)} title="Previous student (k)" aria-label="Previous student">↑</button>
          <button className="btn icon" disabled={idx < 0 || idx >= list.length - 1} onClick={() => setUserId(list[idx + 1].userId)} title="Next student (j)" aria-label="Next student">↓</button>
          {reviewed.has(student.userId) ? (
            <button className="btn on" onClick={() => setReviewed(student.userId, false)} title="Toggle (r)">✓ Reviewed</button>
          ) : (
            <button className="btn primary" onClick={markAndNext} title="Mark reviewed and go to the next unreviewed student (r toggles)">Mark reviewed &amp; next →</button>
          )}
        </div>
        <div className="pane-body" ref={bodyRef}>
          {staleQs.length > 0 && (
            <div className="notice warn" style={{ margin: "14px 16px 0" }}>
              <b>The rubric changed since you reviewed this student.</b> {staleLabel(ctx, student.userId)} now grade{staleQs.length === 1 ? "s" : ""} differently (outlined below). Check {staleQs.length === 1 ? "it" : "them"}, then mark reviewed again.
            </div>
          )}
          {shown.length === 0 && (
            <div className="empty-state">The rubric doesn't grade any questions yet, so every Canvas score stands. Add questions on the Rubric tab.</div>
          )}
          {shown.map((q) => <QuestionCard key={q.id} ctx={ctx} q={q} s={student} cell={r.cells[q.id]} resp={student.responses[q.id]} stale={staleById.get(q.id)} />)}
          {hiddenCount > 0 && (
            <div style={{ padding: "4px 16px 20px" }}>
              <button className="btn sm ghost" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Hide questions not in the rubric" : `Show ${hiddenCount} question${hiddenCount === 1 ? "" : "s"} not in the rubric (Canvas scores stand)`}
              </button>
            </div>
          )}
          {showAll && hiddenCount === 0 && quiz.questions.some((q) => r.cells[q.id].status === "untouched") && (
            <div style={{ padding: "4px 16px 20px" }}><button className="btn sm ghost" onClick={() => setShowAll(false)}>Hide questions not in the rubric</button></div>
          )}
        </div>
      </div>
    </>
  );
}

function QuestionCard({ ctx, q, s, cell, resp, stale }: { ctx: WorkspaceCtx; q: Question; s: Student; cell: Cell; resp?: Response; stale?: StaleQuestion }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const ov = ctx.overrides[overrideKey(s.userId, q.id)];
  const [score, setScore] = useState<string>(ov?.score != null ? String(ov.score) : "");
  const [comment, setComment] = useState<string>(ov?.comment ?? "");
  useEffect(() => { setScore(ov?.score != null ? String(ov.score) : ""); setComment(ov?.comment ?? ""); }, [ov?.score, ov?.comment]);

  function commit(nextScore = score, nextComment = comment) {
    const n = nextScore.trim() === "" ? undefined : Number(nextScore);
    const o = { score: n != null && Number.isFinite(n) ? n : undefined, comment: nextComment.trim() ? nextComment : undefined };
    ctx.setOverride(s.userId, q.id, o.score == null && o.comment == null ? null : o);
  }

  const cls = cell.flags.length ? "flagged" : cell.changed && cell.status !== "untouched" ? "changed" : "";
  return (
    <div className={`qcard ${cls} ${stale ? "stale-review" : ""}`}>
      <div className="qcard-head">
        <b>Q{q.position}</b>
        <span className="muted small">{q.kind}</span>
        <StatusBadge cell={cell} />
        {stale && <span className="badge warn" title="This question's result is different from when you marked the student reviewed">{staleWhy(stale, cell)}</span>}
        <span className="spacer" />
        <ScoreChange from={cell.status === "untouched" || cell.status === "kept" ? null : cell.canvasPoints} to={cell.score} max={cell.max} />
      </div>
      <div className="qcard-body">
        <div className={`prompt ${promptOpen ? "open" : ""}`} onClick={() => setPromptOpen(!promptOpen)} title={promptOpen ? "Click to collapse" : "Click to show the whole question"}>{q.text}</div>
        {ctx.specs.get(q.id)?.note && (
          <div className="notice info small"><span className="muted">Rubric author: </span>{ctx.specs.get(q.id)!.note}</div>
        )}

        {cell.parts ? (
          <table className="grid boxed">
            <thead><tr><th>Blank</th><th>Answer</th><th className="right">Score</th><th>Why</th></tr></thead>
            <tbody>
              {cell.parts.map((p, i) => (
                <tr key={i} className={p.flags.length ? "cell-flag" : ""}>
                  <td className="small muted nowrap">{p.label}</td>
                  <td className="answer-text">{p.text || <span className="faint">(blank)</span>}</td>
                  <td className="right num nowrap">{fmt(p.score)} <span className="faint">/ {fmt(p.max)}</span></td>
                  <td className="small muted">{p.matched.join("; ")}{p.flags.length ? <div className="warn-text">{p.flags.join("; ")}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={`response ${resp?.answered ? "" : "empty"}`}>{resp?.answered ? (showRaw && resp.raw ? resp.raw : resp.text) : "No answer"}</div>
        )}
        {resp?.raw && resp.raw !== resp.text && !cell.parts && (
          <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={() => setShowRaw(!showRaw)}>{showRaw ? "Show text" : "Show original HTML"}</button>
        )}

        {cell.status !== "untouched" && !cell.parts && (cell.matched.length > 0 || cell.flags.length > 0) && (
          <ul className="why">
            {cell.matched.map((m, i) => <li key={i}>{m}</li>)}
            {cell.flags.map((f, i) => <li key={`f${i}`} className="warn-text">{f}</li>)}
          </ul>
        )}
        {cell.comments.length > 0 && cell.status !== "override" && <div className="small"><span className="muted">Comment: </span>{cell.comments.join(" ")}</div>}
        {cell.status === "untouched" && <div className="small muted">Not in the rubric: Canvas's score stands and won't be sent. Override it below to change it anyway.</div>}

        <div className="override">
          <span className="lbl">Override score</span>
          <input type="number" step="any" placeholder={fmt(cell.score)} value={score} aria-label={`Override score for question ${q.position}`}
            onChange={(e) => setScore(e.target.value)} onBlur={() => commit()} onKeyDown={(e) => e.key === "Enter" && commit()} />
          {cell.max != null && <span className="muted small num">/ {fmt(cell.max)}</span>}
          <input type="text" placeholder={ctx.quiz.source === "classic" ? "Comment on this question for the student (optional)" : "Comment for the student (optional, sent as a submission comment)"} value={comment}
            onChange={(e) => setComment(e.target.value)} onBlur={() => commit()} onKeyDown={(e) => e.key === "Enter" && commit()} />
          {ov && <button className="btn sm ghost" onClick={() => { setScore(""); setComment(""); ctx.setOverride(s.userId, q.id, null); }}>Clear</button>}
        </div>
      </div>
    </div>
  );
}

function staleWhy(st: StaleQuestion, cell: Cell): string {
  if (!st.wasGraded) return "newly in rubric";
  if (cell.status === "untouched") return `removed from rubric (was ${fmt(st.was)})`;
  if (st.was !== cell.score) return `changed since review (was ${fmt(st.was)})`;
  if (cell.flags.length) return "newly flagged since review";
  return "comment or flag changed since review";
}
