import { CompanyListItemSchema, type CompanyPollStatus } from "@jobber/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";

const CompanyListSchema = z.array(CompanyListItemSchema);

// Map each poll status to a badge colour + label. Typing the record with the
// union means the compiler forces an entry for every status — add one to the
// enum and this fails to compile until you handle it.
const POLL_BADGE: Record<
	CompanyPollStatus,
	{ variant: BadgeProps["variant"]; label: string }
> = {
	ok: { variant: "green", label: "polling ok" },
	failing: { variant: "red", label: "failing" },
	manual: { variant: "neutral", label: "manual" },
	unknown: { variant: "amber", label: "not polled" },
};

const TIER_LABEL: Record<number, string> = { 1: "A", 2: "B", 3: "C" };

export function CompaniesPage() {
	const { data, isPending, isError } = useQuery({
		queryKey: ["companies"],
		queryFn: () => apiGet("/api/companies", CompanyListSchema),
	});

	return (
		<div className="space-y-4">
			<h2 className="font-semibold text-2xl">Companies</h2>

			{isPending && <p className="text-slate-500">Loading…</p>}
			{isError && <p className="text-red-600">Failed to load companies.</p>}

			{data && (
				<>
					<p className="text-slate-500 text-sm">{data.length} companies</p>
					<div className="rounded-lg border border-slate-200 bg-white">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Company</TableHead>
									<TableHead>ATS</TableHead>
									<TableHead>Tier</TableHead>
									<TableHead>Open jobs</TableHead>
									<TableHead>Status</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.map((c) => {
									const badge = POLL_BADGE[c.pollStatus];
									return (
										<TableRow key={c.id}>
											<TableCell className="font-medium">{c.name}</TableCell>
											<TableCell className="text-slate-600">
												{c.atsType}
											</TableCell>
											<TableCell className="text-slate-600">
												{c.fitGroup
													? (TIER_LABEL[c.fitGroup] ?? c.fitGroup)
													: "—"}
											</TableCell>
											<TableCell className="text-slate-600">
												{c.openJobs}
											</TableCell>
											<TableCell>
												<Badge variant={badge.variant}>{badge.label}</Badge>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>
				</>
			)}
		</div>
	);
}
