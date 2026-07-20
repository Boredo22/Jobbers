import { useSyncExternalStore } from "react";
import { getToasts, subscribe } from "@/lib/toast";

// Renders whatever toasts the store currently holds, bottom-right, above
// everything (including open dialogs — z-50 matches shadcn's overlay layer).
// Mounted once in Layout; pages never render this themselves.
export function Toaster() {
	const toasts = useSyncExternalStore(subscribe, getToasts);
	if (toasts.length === 0) return null;
	return (
		<div className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
			{toasts.map((t) => (
				<div
					key={t.id}
					className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700 text-sm shadow-md"
				>
					{t.message}
				</div>
			))}
		</div>
	);
}
