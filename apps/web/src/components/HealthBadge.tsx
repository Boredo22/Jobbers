import { HealthSchema } from "@jobber/shared";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

/**
 * The Phase 0 deliverable in one component. It exercises the whole loop:
 * React -> TanStack Query -> Vite proxy -> Fastify -> back, with a
 * shared-schema parse in the middle (HealthSchema, imported from @jobber/shared).
 */
export function HealthBadge() {
	const { data, isPending, isError } = useQuery({
		queryKey: ["health"], // cache identity — anything keyed ["health"] shares this data
		queryFn: () => apiGet("/api/health", HealthSchema),
		refetchInterval: 5000, // re-poll every 5s so killing the API flips it red on its own
		refetchIntervalInBackground: true, // keep polling even when the tab isn't focused
		retry: false, // a liveness check shouldn't retry-storm — one failed poll = offline
	});

	const { label, dotClass, textClass } = isPending
		? {
				label: "checking…",
				dotClass: "bg-amber-400",
				textClass: "text-amber-700",
			}
		: isError || !data?.ok
			? {
					label: "API offline",
					dotClass: "bg-red-500",
					textClass: "text-red-700",
				}
			: {
					label: "API healthy",
					dotClass: "bg-green-500",
					textClass: "text-green-700",
				};

	return (
		<div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm">
			<span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
			<span className={textClass}>{label}</span>
			{data?.ts && (
				<span className="text-gray-400">
					· {new Date(data.ts).toLocaleTimeString()}
				</span>
			)}
		</div>
	);
}
