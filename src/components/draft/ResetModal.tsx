"use client";

import { useDraft } from "./DraftRoom";

export function ResetModal() {
  const open = useDraft((s) => s.ui.resetModalOpen);
  const setUi = useDraft((s) => s.setUi);
  const reset = useDraft((s) => s.reset);
  if (!open) return null;
  return (
    <div id="modalOverlay">
      <div className="modalbox">
        <h3>Reset Draft?</h3>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          This will erase all picks and cannot be undone.
        </div>
        <div className="mbtns">
          <button onClick={() => setUi({ resetModalOpen: false })}>Cancel</button>
          <button className="danger" onClick={reset}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
