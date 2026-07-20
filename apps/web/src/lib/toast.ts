// ---------------------------------------------------------------------------
// toast.ts — a tiny error-toast store (no library).
//
// The problem it solves: several mutations (feedback, dismiss, mark applied,
// status change, activate resume) had NO error UI at all — a failed request
// looked identical to a successful one. Any component can now call
// toastError("...") from a mutation's onError and a red toast appears for a
// few seconds, app-wide.
//
// Shape: a module-level store + subscribe/getSnapshot, consumed by <Toaster>
// via React's useSyncExternalStore — the built-in hook for "state that lives
// outside React". No context provider needed; importing the function is the
// whole API.
// ---------------------------------------------------------------------------

export type Toast = { id: number; message: string };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}

/** Show a red toast for a few seconds, then auto-dismiss it. */
export function toastError(message: string): void {
	const id = nextId++;
	// Replace, never mutate: useSyncExternalStore compares snapshots by
	// reference, so the array must be a new object each change.
	toasts = [...toasts, { id, message }];
	emit();
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
		emit();
	}, 5000);
}

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getToasts(): Toast[] {
	return toasts;
}
