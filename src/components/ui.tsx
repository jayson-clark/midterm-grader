import { useState, type ReactNode } from "react";
import { openBackupsFolder } from "../lib/canvas";
import type { Cell } from "../lib/grader";

export const fmt = (n: number | null | undefined, digits = 2) =>
  n == null || Number.isNaN(n) ? "–" : String(Math.round(n * 10 ** digits) / 10 ** digits);

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Logo() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden>
      <rect x="64" y="64" width="896" height="896" rx="200" fill="#1f3a5f" />
      <rect x="250" y="190" width="524" height="644" rx="56" fill="#f4f1ea" />
      <rect x="330" y="300" width="250" height="36" rx="18" fill="#9aa7b8" />
      <rect x="330" y="420" width="300" height="36" rx="18" fill="#9aa7b8" />
      <path d="M520 700 l70 70 l150 -190" stroke="#2f9e6e" strokeWidth="64" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "3 → 5" with color for up/down. */
export function ScoreChange({ from, to, max }: { from: number | null; to: number | null; max?: number | null }) {
  const changed = to != null && (from == null || Math.abs(to - from) > 1e-3);
  const cls = !changed ? "" : from == null || (to ?? 0) > from ? "up" : "down";
  return (
    <span className={`score ${cls}`}>
      {changed && <span className="from">{fmt(from)}</span>}
      {fmt(to)}
      {max != null && <span className="faint"> / {fmt(max)}</span>}
    </span>
  );
}

export function StatusBadge({ cell }: { cell: Cell }) {
  if (cell.status === "override") return <span className="badge accent">override</span>;
  if (cell.status === "kept") return <span className="badge">use: canvas</span>;
  if (cell.status === "untouched") return <span className="badge">not in rubric</span>;
  if (cell.flags.length) return <span className="badge warn">needs review</span>;
  if (cell.changed) return <span className="badge good">regraded</span>;
  return <span className="badge">same as Canvas</span>;
}

export function Modal({ title, children, footer, onClose }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose?: () => void }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal>
        <div className="modal-head"><h2>{title}</h2></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Opens the folder where the scores Canvas had before each send are saved. */
export function BackupsButton({ className = "btn", label = "Open backups folder" }: { className?: string; label?: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <button className={className} title={error ?? "Each time you send, the scores Canvas had before are saved here"}
      onClick={() => { setError(null); openBackupsFolder().catch((e) => setError(String(e))); }}>
      {error ? "Couldn't open the folder" : label}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="notice bad">{error}</div>;
}
