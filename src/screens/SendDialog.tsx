import { useEffect, useMemo, useState } from "react";
import { getAssignment, hideGrades, setManualPosting } from "../lib/canvas";
import { backupBeforeWrite, executeWrites, planWrites, type WriteResult } from "../lib/writeback";
import { ErrorNote, fmt, Modal, ScoreChange, Spinner } from "../components/ui";
import type { WorkspaceCtx } from "./Workspace";

type Stage = "plan" | "running" | "done";

export function SendDialog({ ctx, onClose }: { ctx: WorkspaceCtx; onClose: () => void }) {
  const { quiz, results, reviewed } = ctx;
  const nq = quiz.source === "new_quizzes_csv";
  const [onlyReviewed, setOnlyReviewed] = useState(reviewed.size > 0);
  const [summaryComment, setSummaryComment] = useState(false);
  const [postManually, setPostManually] = useState<boolean | null>(null);
  const [makeManual, setMakeManual] = useState(true);
  const [hideExisting, setHideExisting] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [stage, setStage] = useState<Stage>("plan");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [log, setLog] = useState<WriteResult[]>([]);
  const [backup, setBackup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAssignment(quiz.courseId!, quiz.assignmentId!)
      .then((a) => setPostManually(!!a.post_manually))
      .catch((e) => setError(`Couldn't check the assignment's posting policy: ${e.message}`));
  }, [quiz.courseId, quiz.assignmentId]);

  const plan = useMemo(() => planWrites(quiz, results, { summaryComment, onlyReviewed, reviewed }), [quiz, results, summaryComment, onlyReviewed, reviewed]);
  const sendable = plan.filter((p) => !p.blocked);
  const unreviewedChanged = [...results.values()].filter((r) => r.changed && !reviewed.has(r.userId)).length;

  async function run() {
    setStage("running");
    setError(null);
    try {
      setBackup(await backupBeforeWrite(quiz, plan));
      if (postManually === false && makeManual) await setManualPosting(quiz.assignmentId!);
      if (postManually === false && hideExisting) await hideGrades(quiz.assignmentId!);
    } catch (e) {
      setError(`Stopped before changing any grades: ${(e as Error).message}`);
      setStage("plan");
      return;
    }
    setProgress({ done: 0, total: sendable.length });
    const out = await executeWrites(quiz, plan, (done, total, last) => {
      setProgress({ done, total });
      setLog((l) => [...l, last]);
    }).catch((e) => { setError((e as Error).message); return null; });
    if (out) setLog(out);
    setStage("done");
  }

  const ok = log.filter((l) => l.ok).length;
  const failed = log.filter((l) => !l.ok);

  return (
    <Modal
      title={stage === "done" ? "Done" : `Send to Canvas: ${quiz.title}`}
      onClose={stage === "running" ? undefined : onClose}
      footer={
        stage === "plan" ? (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!confirmed || sendable.length === 0 || postManually == null} onClick={run}>
              Send {sendable.length} update{sendable.length === 1 ? "" : "s"}
            </button>
          </>
        ) : stage === "running" ? (
          <span className="row muted"><Spinner /> Sending… don't close the app</span>
        ) : (
          <button className="btn primary" onClick={onClose}>Close</button>
        )
      }
    >
      {stage === "plan" && (
        <>
          {nq ? (
            <div className="notice warn small">
              <b>New Quizzes: only the total score can be updated.</b> Canvas has no API for per-question scores in New Quizzes, so each student's
              assignment score is set to <i>Canvas total − Canvas points on rubric questions + rubric points</i>. The question-by-question
              breakdown inside the quiz won't show these changes, and a later regrade inside New Quizzes can overwrite them.
            </div>
          ) : (
            <div className="notice info small">
              Each student's quiz submission gets new scores only on the questions the rubric (or your overrides) changed. Other questions aren't touched.
              Comments are added only where the rubric or you wrote one.
            </div>
          )}

          {postManually === null && !error && <div className="row muted small"><Spinner /> Checking posting policy…</div>}
          {postManually === true && <div className="notice good small">This assignment posts grades manually, so students won't see these changes until someone posts them.</div>}
          {postManually === false && (
            <div className="notice warn small col" style={{ gap: 6 }}>
              <div><b>This assignment posts grades automatically.</b> Students would see changes immediately.</div>
              <label className="row"><input type="checkbox" checked={makeManual} onChange={(e) => setMakeManual(e.target.checked)} /> Switch it to manual posting first (recommended)</label>
              <label className="row"><input type="checkbox" checked={hideExisting} onChange={(e) => setHideExisting(e.target.checked)} /> Also hide grades students can already see, so updated scores stay hidden until you post</label>
            </div>
          )}

          <div className="col small">
            <label className="row"><input type="checkbox" checked={onlyReviewed} onChange={(e) => setOnlyReviewed(e.target.checked)} /> Only send students marked reviewed ({reviewed.size})</label>
            {!onlyReviewed && unreviewedChanged > 0 && <div className="faint" style={{ marginLeft: 22 }}>{unreviewedChanged} regraded student(s) haven't been reviewed.</div>}
            {nq && <label className="row"><input type="checkbox" checked={summaryComment} onChange={(e) => setSummaryComment(e.target.checked)} /> Add a submission comment listing the per-question changes (visible to the student once grades are posted)</label>}
          </div>

          <div className="card" style={{ maxHeight: 280, overflow: "auto" }}>
            <table className="grid">
              <thead><tr><th>Student</th><th>Changes</th><th className="right">Total</th></tr></thead>
              <tbody>
                {plan.map((p) => (
                  <tr key={p.userId}>
                    <td className="nowrap">{p.name}{p.blocked && <div className="small error-text">{p.blocked}</div>}</td>
                    <td className="small">{p.questions.map((q) => `Q${q.position}: ${fmt(q.from)}→${fmt(q.to)}`).join(", ")}</td>
                    <td className="right"><ScoreChange from={p.canvasScore} to={p.newScore} /></td>
                  </tr>
                ))}
                {plan.length === 0 && <tr><td colSpan={3} className="muted">Nothing to send{onlyReviewed ? " (no reviewed students with changes)" : ""}.</td></tr>}
              </tbody>
            </table>
          </div>
          <ErrorNote error={error} />
          <label className="row"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I've reviewed these changes and want to write them to Canvas.</label>
          <div className="faint small">A backup of the current Canvas scores is saved before anything is sent.</div>
        </>
      )}

      {stage !== "plan" && (
        <>
          <div className="progress"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div className="small muted">{progress.done} / {progress.total}{stage === "done" ? ` · ${ok} updated, ${failed.length} failed or skipped` : ""}</div>
          {backup && <div className="small muted">Backup of previous scores: <span className="mono">{backup}</span></div>}
          <ErrorNote error={error} />
          {stage === "done" && postManually === false && makeManual && <div className="notice info small">Grades are hidden. Review them in SpeedGrader / the Gradebook and post when ready.</div>}
          <div className="card" style={{ maxHeight: 300, overflow: "auto" }}>
            {log.map((l) => (
              <div key={l.userId} className="row small" style={{ padding: "5px 10px", borderBottom: "1px solid var(--line)" }}>
                <span style={{ color: l.ok ? "var(--good)" : "var(--bad)", width: 14 }}>{l.ok ? "✓" : "✕"}</span>
                <span className="nowrap">{l.name}</span>
                <span className="muted grow">{l.message}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
