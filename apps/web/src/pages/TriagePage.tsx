import {
	AiSpendSchema,
	ApplicationWithEventsSchema,
	type ScoreVerdict,
	type TriageItem,
	TriageItemSchema,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { TailorDialog } from "@/components/TailorDialog";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { apiGet, apiSend } from "@/lib/api";

const TriageListSchema = z.array(TriageItemSchema);
const OkSchema = z.object({ ok: z.literal(true) });

// Admin-action response shapes (the buttons that replace the CLI scripts).
const EnqueueSchema = z.object({ enqueued: z.number().int() });
const DrainSchema = z.object({
	processed: z.number().int(),
	scored: z.number().int(),
	failed: z.number().int(),
	notified: z.number().int(),
});
const PollSummarySchema = z
	.object({ newCount: z.number().int(), candidateCount: z.number().int() })
	.passthrough();

// Score → badge colour. The anchors from the prompt made flesh: 8+ is "apply
// today" (green), 6–8 is "maybe" (amber), below is "probably not" (neutral).
function scoreVariant(score: number): BadgeProps["variant"] {
	if (score >= 8) return "green";
	if (score >= 6) return "amber";
	return "neutral";
}

function fmtComp(min: number | null, max: number | null): string | null {
	if (min == null && max == null) return null;
	const f = (n: number) => `$${Math.round(n / 1000)}k`;
	if (min != null && max != null) return `${f(min)}–${f(max)}`;
	return f((min ?? max) as number);
}

export function TriagePage() {
	const queryClient = useQueryClient();
	const invalidateTriage = () =>
		queryClient.invalidateQueries({ queryKey: ["triage"] });

	// Which card's tailor dialog is open (null = closed).
	const [tailoring, setTailoring] = useState<TriageItem | null>(null);

	const { data, isPending, isError } = useQuery({
		queryKey: ["triage"],
		queryFn: () => apiGet("/api/triage", TriageListSchema),
	});

	const spend = useQuery({
		queryKey: ["ai-spend"],
		queryFn: () => apiGet("/api/stats/ai-spend", AiSpendSchema),
	});

	// 👍/👎 — updates the score's feedback, then refetches so the buttons reflect it.
	const feedback = useMutation({
		mutationFn: (vars: { id: string; verdict: ScoreVerdict }) =>
			apiSend(
				`/api/scores/${vars.id}/feedback`,
				"POST",
				{ verdict: vars.verdict },
				OkSchema,
			),
		onSuccess: invalidateTriage,
	});

	// Dismiss — hides the card from triage (server sets dismissed=true).
	const dismiss = useMutation({
		mutationFn: (id: string) =>
			apiSend(`/api/scores/${id}/dismiss`, "POST", {}, OkSchema),
		onSuccess: invalidateTriage,
	});

	// Mark applied — creates a linked application (so it also shows in Pipeline),
	// which removes it from triage (the /api/triage query excludes applied postings).
	const markApplied = useMutation({
		mutationFn: (item: TriageItem) =>
			apiSend(
				"/api/applications",
				"POST",
				{
					companyName: item.companyName,
					roleTitle: item.title,
					channel: "ats",
					jobPostingId: item.jobPostingId,
					companyId: item.companyId,
				},
				ApplicationWithEventsSchema,
			),
		onSuccess: () => {
			invalidateTriage();
			// The Pipeline page reads this query — keep it fresh so the new card shows.
			queryClient.invalidateQueries({ queryKey: ["applications"] });
		},
	});

	// Poll every board for new postings (replaces `pnpm --filter api ...poll` /
	// the admin poll route). Slow-ish — it fetches all the boards — so the button
	// shows a pending state. New candidates get auto-enqueued by the poll itself.
	const poll = useMutation({
		mutationFn: () => apiSend("/api/admin/poll", "POST", {}, PollSummarySchema),
		onSuccess: () => {
			invalidateTriage();
			queryClient.invalidateQueries({ queryKey: ["applications"] });
		},
	});

	// Score open candidates now: enqueue a batch, then drain it in a loop until the
	// queue is clear (capped so a click can't run away). Replaces the two CLI
	// commands the empty state used to tell you to run: score:enqueue + score:drain.
	const scoreNow = useMutation({
		mutationFn: async () => {
			const { enqueued } = await apiSend(
				"/api/admin/score-candidates",
				"POST",
				{},
				EnqueueSchema,
			);
			let scored = 0;
			let failed = 0;
			// Each drain scores one batch; loop (bounded) so a full queue clears.
			for (let i = 0; i < 6; i++) {
				const s = await apiSend(
					"/api/admin/score-drain",
					"POST",
					{},
					DrainSchema,
				);
				scored += s.scored;
				failed += s.failed;
				if (s.processed === 0) break;
			}
			return { enqueued, scored, failed };
		},
		onSuccess: () => {
			invalidateTriage();
			queryClient.invalidateQueries({ queryKey: ["ai-spend"] });
		},
	});

	// Is a given card mid-action? Used to disable that card's buttons only.
	const busy = (id: string) =>
		(feedback.isPending && feedback.variables?.id === id) ||
		(dismiss.isPending && dismiss.variables === id) ||
		(markApplied.isPending && markApplied.variables?.scoreId === id);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h2 className="font-semibold text-2xl">Triage</h2>
				{spend.data && (
					<div className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-right">
						<div className="font-semibold text-sm tabular-nums">
							${spend.data.totalUsd.toFixed(2)}
						</div>
						<div className="text-slate-400 text-xs">
							AI spend · {spend.data.month} · {spend.data.runs} runs
						</div>
					</div>
				)}
			</div>

			{/* Refill the queue without touching a terminal: poll the boards for new
			    postings, and score open candidates on demand. */}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					variant="outline"
					disabled={poll.isPending}
					onClick={() => poll.mutate()}
				>
					{poll.isPending ? "Polling boards…" : "↻ Poll boards"}
				</Button>
				<Button
					size="sm"
					disabled={scoreNow.isPending}
					onClick={() => scoreNow.mutate()}
				>
					{scoreNow.isPending ? "Scoring…" : "⚡ Score candidates"}
				</Button>
				{poll.data && (
					<span className="text-slate-500 text-xs">
						Polled: {poll.data.newCount} new, {poll.data.candidateCount}{" "}
						candidate(s).
					</span>
				)}
				{scoreNow.data && (
					<span className="text-slate-500 text-xs">
						Scored {scoreNow.data.scored} (queued {scoreNow.data.enqueued}
						{scoreNow.data.failed ? `, ${scoreNow.data.failed} failed` : ""}).
					</span>
				)}
				{(poll.isError || scoreNow.isError) && (
					<span className="text-red-600 text-xs">
						Action failed — is the API running and the key set?
					</span>
				)}
			</div>

			{isPending && <p className="text-slate-500">Loading…</p>}
			{isError && <p className="text-red-600">Failed to load triage.</p>}
			{data && data.length === 0 && (
				<p className="text-slate-500">
					Nothing to triage. Click <strong>⚡ Score candidates</strong> to score
					open postings, or <strong>↻ Poll boards</strong> to fetch new ones.
				</p>
			)}

			<div className="grid gap-3">
				{data?.map((item) => (
					<Card key={item.scoreId}>
						<CardContent className="p-4">
							<div className="flex items-start gap-3">
								<Badge
									variant={scoreVariant(item.score)}
									className="mt-0.5 shrink-0 tabular-nums"
								>
									{item.score.toFixed(1)}
								</Badge>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-baseline gap-x-2">
										<span className="font-medium">{item.title}</span>
										<span className="text-slate-500 text-sm">
											{item.companyName}
										</span>
									</div>
									<div className="mt-0.5 flex flex-wrap items-center gap-2 text-slate-500 text-xs">
										{item.location && <span>{item.location}</span>}
										{item.remote && <Badge variant="blue">remote</Badge>}
										{fmtComp(item.compMin, item.compMax) && (
											<span className="tabular-nums">
												{fmtComp(item.compMin, item.compMax)}
											</span>
										)}
										{item.credentialGapFlag && (
											<Badge variant="red">⚠ credential gap</Badge>
										)}
									</div>
								</div>
							</div>

							{/* Match points and gaps, side by side on wide screens. */}
							<div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
								<ul className="space-y-1">
									{item.matchPoints.map((p) => (
										<li key={p} className="flex gap-1.5 text-slate-700">
											<span className="text-green-600">✓</span>
											<span>{p}</span>
										</li>
									))}
								</ul>
								<ul className="space-y-1">
									{item.gaps.map((g) => (
										<li key={g} className="flex gap-1.5 text-slate-500">
											<span className="text-amber-600">–</span>
											<span>{g}</span>
										</li>
									))}
								</ul>
							</div>

							<details className="mt-2">
								<summary className="cursor-pointer text-slate-500 text-xs">
									Why this score
								</summary>
								<p className="mt-1 text-slate-600 text-sm">{item.rationale}</p>
							</details>

							{/* Actions. Buttons disable while this card is mid-action. */}
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<a href={item.url} target="_blank" rel="noreferrer">
									<Button variant="outline" size="sm">
										Open ↗
									</Button>
								</a>
								<Button
									size="sm"
									disabled={busy(item.scoreId)}
									onClick={() => markApplied.mutate(item)}
								>
									Mark applied
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setTailoring(item)}
								>
									✨ Tailor
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy(item.scoreId)}
									onClick={() => dismiss.mutate(item.scoreId)}
								>
									Dismiss
								</Button>
								<div className="ml-auto flex gap-1">
									<Button
										variant={item.feedback === "up" ? "primary" : "outline"}
										size="sm"
										disabled={busy(item.scoreId)}
										onClick={() =>
											feedback.mutate({ id: item.scoreId, verdict: "up" })
										}
									>
										👍
									</Button>
									<Button
										variant={item.feedback === "down" ? "primary" : "outline"}
										size="sm"
										disabled={busy(item.scoreId)}
										onClick={() =>
											feedback.mutate({ id: item.scoreId, verdict: "down" })
										}
									>
										👎
									</Button>
								</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			<TailorDialog
				key={tailoring?.jobPostingId ?? "none"}
				item={tailoring}
				onClose={() => setTailoring(null)}
			/>
		</div>
	);
}
