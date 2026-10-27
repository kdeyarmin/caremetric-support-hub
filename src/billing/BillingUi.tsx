import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** A modal panel for one billing form. Escape and the close button dismiss it unless a request is in flight. */
export function Sheet({ title, onClose, busy = false, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return <div className="billing-sheet-backdrop">
    <section className="billing-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="billing-sheet-head"><h2 ref={heading} tabIndex={-1}>{title}</h2>
        <button type="button" className="button button-secondary button-small" onClick={onClose} disabled={busy} aria-label="Close"><X size={15} aria-hidden="true" /></button></div>
      {children}
    </section>
  </div>;
}

export function StatusChip({ status, label }: { status: string; label?: string }) {
  return <span className={`billing-chip billing-chip-${status}`}>{label ?? status.replaceAll('_', ' ')}</span>;
}

export function Notice({ text, error }: { text?: string; error?: string }) {
  return <>{text && <p className="billing-notice" role="status">{text}</p>}{error && <p className="billing-error" role="alert">{error}</p>}</>;
}
