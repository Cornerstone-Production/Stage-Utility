// connection-field.tsx — a label with its hint on the left and the input on the right, as the Public link mockup lays it out.

import type { ReactNode } from "react";

export function ConnectionField({ label, hint, id, children }: { label: string; hint?: string; id: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-2.5 max-[560px]:grid-cols-1">
      <label htmlFor={id} className="pt-1.5 text-footnote text-fg">
        {label}
        {hint && <span className="block text-caption2 text-fg-muted">{hint}</span>}
      </label>
      {children}
    </div>
  );
}
