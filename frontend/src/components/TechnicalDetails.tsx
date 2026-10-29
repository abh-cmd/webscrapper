import { useState, type ReactNode } from 'react';

// The one, consistent place deeper technical info lives — never a global
// mode switch, just an inline reveal right next to the plain-language
// output it belongs to.
export function TechnicalDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <button className="details-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide technical details ▲' : 'Show technical details ▼'}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}
