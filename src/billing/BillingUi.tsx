import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** A modal panel for one billing form. Escape and the close button dismiss it unless a request is in flight. */
export function Sheet({ title, onClose, busy = false, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const targets = Array.from(dialog.current.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter(element => !element.matches(':disabled, [hidden], input[type="hidden"]') && element.tabIndex >= 0 && !element.closest('[hidden]'));
      const first = targets[0], last = targets.at(-1), active = document.activeElement;
      if (!first) { event.preventDefault(); heading.current?.focus(); }
      else if (event.shiftKey && (active === first || active === heading.current || !dialog.current.contains(active))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || !dialog.current.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return <div className="billing-sheet-backdrop">
    <section ref={dialog} className="billing-sheet" role="dialog" aria-modal="true" aria-label={title}>
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
