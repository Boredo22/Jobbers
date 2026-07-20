import {
	type ResumeVersion,
	ResumeVersionSchema,
	type TailorAssembleResult,
	TailorAssembleResultSchema,
	type TailoredDraft,
	TailoredDraftRecordSchema,
	TailoredDraftSchema,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { diffWords } from "diff";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { apiGet, apiSend } from "@/lib/api";

// ---------------------------------------------------------------------------
// TailorDialog — the tailor-to-posting flow (step 3.2b + tailor-v2), opened from
// a triage card OR a pipeline card. Pick a base resume, generate AI edits + a
// keyword-coverage map + a draft outreach note for THIS posting, review the edits
// as before/after word diffs, then assemble the full tailored resume (a free,
// deterministic step) and download it. Everything is a draft the human finishes.
// ---------------------------------------------------------------------------

// The minimum the dialog needs to know about a posting. TriageItem satisfies
// this structurally; PipelinePage builds one from an application row.
export type TailorTarget = {
	jobPostingId: string;
	title: string;
	companyName: string;
};

const ResumeListSchema = z.array(ResumeVersionSchema);
// Generate now echoes the base it used, so save/assemble record the exact base.
const GenerateResponseSchema = z.object({
	draft: TailoredDraftSchema,
	resumeVersionId: z.string().uuid(),
});

// A filename-safe version of "Company — Title" for the downloaded .md.
function safeFilename(name: string): string {
	return `${name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120)}.md`;
}

// Trigger a client-side download of `text` as a markdown file. No server round-trip
// — the assembled resume already lives on the client, so this is a pure Blob URL.
function downloadMarkdown(filename: string, text: string): void {
	const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

// One edit's before→after, rendered as a two-column word diff: deletions
// highlighted on the left (original), additions on the right (tailored). Keys are
// built from a running character offset so they're stable without using the array
// index (which Biome's recommended preset forbids as a React key).
function WordDiff({
	original,
	tailored,
}: {
	original: string;
	tailored: string;
}) {
	const parts = diffWords(original, tailored);
	let offset = 0;
	const keyed = parts.map((p) => {
		const key = `${offset}:${p.value}`;
		offset += p.value.length;
		return { key, ...p };
	});

	return (
		<div className="grid gap-2 sm:grid-cols-2">
			<div className="rounded border border-slate-200 bg-white p-2 text-slate-700 text-xs">
				{original === "" ? (
					<span className="text-slate-400 italic">(new content)</span>
				) : (
					keyed
						.filter((p) => !p.added)
						.map((p) => (
							<span
								key={p.key}
								className={
									p.removed ? "bg-red-100 text-red-700 line-through" : ""
								}
							>
								{p.value}
							</span>
						))
				)}
			</div>
			<div className="rounded border border-slate-200 bg-white p-2 text-slate-700 text-xs">
				{keyed
					.filter((p) => !p.removed)
					.map((p) => (
						<span
							key={p.key}
							className={p.added ? "bg-green-100 text-green-800" : ""}
						>
							{p.value}
						</span>
					))}
			</div>
		</div>
	);
}

// The keyword-coverage map: one chip per ad keyword, green when the resume already
// truthfully covers it, amber when it's a gap. The honest note is the tooltip.
function KeywordChips({ keywords }: { keywords: TailoredDraft["keywords"] }) {
	if (keywords.length === 0) return null;
	return (
		<div className="space-y-1.5">
			<h4 className="font-medium text-slate-600 text-sm">
				Keywords from the ad{" "}
				<span className="font-normal text-slate-400">
					(green = covered, amber = gap — hover for the note)
				</span>
			</h4>
			<div className="flex flex-wrap gap-1.5">
				{keywords.map((k) => (
					<Badge
						key={k.keyword}
						variant={k.covered ? "green" : "amber"}
						title={k.note}
						className="cursor-help"
					>
						{k.covered ? "✓" : "△"} {k.keyword}
					</Badge>
				))}
			</div>
		</div>
	);
}

export function TailorDialog({
	item,
	onClose,
}: {
	item: TailorTarget | null;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	// The current draft (starts as the model's output; the outreach note is then
	// human-editable before saving). State resets automatically when a different
	// posting is opened because the parent remounts this component via `key`.
	const [draft, setDraft] = useState<TailoredDraft | null>(null);
	const [saved, setSaved] = useState(false);
	// The base resume the draft was tailored from — echoed back by generate, so
	// save + assemble record the exact version (provenance can't drift).
	const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
	// The assembled full resume (after the deterministic assemble step) + its
	// editable text for download. Cleared whenever a new draft is generated.
	const [assembled, setAssembled] = useState<TailorAssembleResult | null>(null);
	const [assembledText, setAssembledText] = useState("");

	// Bases to choose from (tailored versions aren't valid bases to tailor from).
	const resumes = useQuery({
		queryKey: ["resumes"],
		queryFn: () => apiGet("/api/resumes", ResumeListSchema),
		enabled: item !== null,
	});
	const bases: ResumeVersion[] = (resumes.data ?? []).filter(
		(r) => r.kind === "base",
	);

	// The last SAVED draft for this posting (null until one is saved). Shared
	// query key with PipelinePage's outreach-note section, so a save here
	// refreshes there automatically.
	const existing = useQuery({
		queryKey: ["tailor-draft", item?.jobPostingId],
		queryFn: () =>
			apiGet(
				`/api/postings/${item?.jobPostingId}/tailor`,
				TailoredDraftRecordSchema.nullable(),
			),
		enabled: item !== null,
	});

	// Pre-load the saved draft on open (resume where you left off), including the
	// base it used. One-time init: once `draft` is set, this never overwrites.
	useEffect(() => {
		if (existing.data && draft === null) {
			setDraft(existing.data);
			setSaved(true);
			if (existing.data.resumeVersionId)
				setBaseVersionId(existing.data.resumeVersionId);
		}
	}, [existing.data, draft]);

	// Default the base picker to the active resume once the list loads (unless a
	// saved draft already pinned one). Keeps the common case one-click.
	useEffect(() => {
		if (baseVersionId === null && bases.length > 0) {
			setBaseVersionId((bases.find((b) => b.active) ?? bases[0])?.id ?? null);
		}
	}, [bases, baseVersionId]);

	const generate = useMutation({
		mutationFn: (jobPostingId: string) =>
			apiSend(
				`/api/postings/${jobPostingId}/tailor`,
				"POST",
				baseVersionId ? { resumeVersionId: baseVersionId } : {},
				GenerateResponseSchema,
			),
		onSuccess: (data) => {
			setDraft(data.draft);
			setBaseVersionId(data.resumeVersionId); // the base actually used
			setSaved(false);
			setAssembled(null);
			setAssembledText("");
		},
	});

	const save = useMutation({
		mutationFn: (vars: {
			jobPostingId: string;
			body: TailoredDraft & { resumeVersionId: string };
		}) =>
			apiSend(
				`/api/postings/${vars.jobPostingId}/tailor/save`,
				"POST",
				vars.body,
				TailoredDraftRecordSchema,
			),
		onSuccess: (_data, vars) => {
			setSaved(true);
			queryClient.invalidateQueries({
				queryKey: ["tailor-draft", vars.jobPostingId],
			});
		},
	});

	const assemble = useMutation({
		mutationFn: (vars: {
			jobPostingId: string;
			body: { draft: TailoredDraft; resumeVersionId: string };
		}) =>
			apiSend(
				`/api/postings/${vars.jobPostingId}/tailor/resume`,
				"POST",
				vars.body,
				TailorAssembleResultSchema,
			),
		onSuccess: (data) => {
			setAssembled(data);
			setAssembledText(data.resume.extractedText);
			// A tailored resume_versions row (and the application link) just appeared.
			queryClient.invalidateQueries({ queryKey: ["resumes"] });
			queryClient.invalidateQueries({ queryKey: ["applications"] });
		},
	});

	// A 409 means "no active resume" — surface that specific, actionable message.
	const genErr =
		generate.error instanceof Error && generate.error.message.startsWith("409")
			? "Upload and activate a resume on the Resume page first."
			: generate.isError
				? "Tailoring failed — is the API key set?"
				: null;

	return (
		<Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
			{item && (
				<DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
					<DialogTitle>Tailor to · {item.title}</DialogTitle>
					<DialogDescription>
						{item.companyName} — draft resume edits + an outreach note for this
						posting. Everything is a draft; you finish and send it by hand.
					</DialogDescription>

					{/* Base picker — which resume to tailor from. Locked once a draft
					    exists (re-tailor to switch bases). */}
					<div className="mt-4 flex flex-wrap items-center gap-2">
						<label
							htmlFor="tailor-base"
							className="font-medium text-slate-600 text-sm"
						>
							Base resume
						</label>
						<select
							id="tailor-base"
							className="rounded-md border border-slate-300 p-1.5 text-slate-700 text-sm disabled:bg-slate-100 disabled:text-slate-400"
							value={baseVersionId ?? ""}
							disabled={draft !== null || bases.length === 0}
							onChange={(e) => setBaseVersionId(e.target.value || null)}
						>
							{bases.length === 0 && <option value="">No resumes yet</option>}
							{bases.map((b) => (
								<option key={b.id} value={b.id}>
									{b.label}
									{b.active ? " (active)" : ""}
								</option>
							))}
						</select>
						{draft && (
							<span className="text-slate-400 text-xs">
								locked — re-tailor to switch
							</span>
						)}
					</div>

					{!draft && existing.isPending && (
						<p className="mt-4 text-slate-500 text-sm">
							Checking for a saved draft…
						</p>
					)}

					{!draft && !existing.isPending && (
						<div className="mt-4">
							<Button
								disabled={generate.isPending || baseVersionId === null}
								onClick={() => generate.mutate(item.jobPostingId)}
							>
								{generate.isPending ? "Tailoring…" : "✨ Tailor with AI"}
							</Button>
							{genErr && <p className="mt-2 text-red-600 text-sm">{genErr}</p>}
						</div>
					)}

					{draft && (
						<div className="mt-4 space-y-5">
							{/* Angle */}
							<p className="rounded-md bg-slate-50 p-3 text-slate-700 text-sm">
								{draft.summary}
							</p>

							{/* Keyword-coverage map */}
							<KeywordChips keywords={draft.keywords} />

							{/* Resume edits, each a before/after diff */}
							<div className="space-y-4">
								<h4 className="font-medium text-slate-600 text-sm">
									Suggested resume edits
								</h4>
								{draft.edits.map((e) => (
									<div
										key={`${e.section}:${e.original}`}
										className="space-y-1.5"
									>
										<div className="font-medium text-slate-700 text-sm">
											{e.section}
										</div>
										<WordDiff original={e.original} tailored={e.tailored} />
										<p className="text-slate-500 text-xs">↳ {e.rationale}</p>
									</div>
								))}
							</div>

							{/* Outreach note — the human-finished, editable part */}
							<div className="space-y-1.5">
								<h4 className="font-medium text-slate-600 text-sm">
									Draft outreach note{" "}
									<span className="font-normal text-slate-400">
										(edit before you save — never auto-sent)
									</span>
								</h4>
								<textarea
									className="h-40 w-full rounded-md border border-slate-300 p-2 text-slate-700 text-sm"
									value={draft.outreachNote}
									onChange={(ev) => {
										setDraft({ ...draft, outreachNote: ev.target.value });
										setSaved(false);
									}}
								/>
							</div>

							<div className="flex items-center gap-3">
								<Button
									disabled={save.isPending || baseVersionId === null}
									onClick={() =>
										baseVersionId &&
										save.mutate({
											jobPostingId: item.jobPostingId,
											body: { ...draft, resumeVersionId: baseVersionId },
										})
									}
								>
									{save.isPending ? "Saving…" : "Save draft"}
								</Button>
								<Button
									variant="outline"
									disabled={generate.isPending}
									onClick={() => generate.mutate(item.jobPostingId)}
								>
									↻ Re-tailor
								</Button>
								{saved && (
									<span className="text-green-700 text-sm">
										✓ Saved — attached to the application.
									</span>
								)}
								{save.isError && (
									<span className="text-red-600 text-sm">Save failed.</span>
								)}
							</div>

							{/* Deterministic assembly → a full, downloadable tailored resume.
							    No AI cost; this is what creates the resume version + link. */}
							<div className="space-y-2 border-slate-200 border-t pt-4">
								<h4 className="font-medium text-slate-600 text-sm">
									Full tailored resume
								</h4>
								<p className="text-slate-400 text-xs">
									Applies every edit above to the base — no AI, no invented
									text. Creates a saved tailored version and links it to the
									application.
								</p>
								<Button
									disabled={assemble.isPending || baseVersionId === null}
									onClick={() =>
										baseVersionId &&
										assemble.mutate({
											jobPostingId: item.jobPostingId,
											body: { draft, resumeVersionId: baseVersionId },
										})
									}
								>
									{assemble.isPending
										? "Assembling…"
										: "🧩 Assemble full resume"}
								</Button>
								{assemble.isError && (
									<span className="ml-2 text-red-600 text-sm">
										Assemble failed.
									</span>
								)}

								{assembled && (
									<div className="space-y-2">
										{assembled.failed.length > 0 && (
											<div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-800 text-xs">
												<span className="font-medium">
													Couldn't auto-apply {assembled.failed.length} edit
													{assembled.failed.length > 1 ? "s" : ""}
												</span>{" "}
												— the quoted text wasn't found verbatim. Do these by
												hand:
												<ul className="mt-1 space-y-0.5">
													{assembled.failed.map((f) => (
														<li key={`${f.section}:${f.original}`}>
															•{" "}
															<span className="font-medium">{f.section}:</span>{" "}
															{f.tailored}
														</li>
													))}
												</ul>
											</div>
										)}
										<textarea
											className="h-72 w-full rounded-md border border-slate-300 p-2 font-mono text-slate-700 text-xs"
											value={assembledText}
											onChange={(ev) => setAssembledText(ev.target.value)}
										/>
										<div className="flex items-center gap-2">
											<Button
												variant="outline"
												size="sm"
												onClick={() =>
													navigator.clipboard.writeText(assembledText)
												}
											>
												Copy
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() =>
													downloadMarkdown(
														safeFilename(
															assembled.resume.label ||
																`${item.companyName} — ${item.title}`,
														),
														assembledText,
													)
												}
											>
												Download .md
											</Button>
											<span className="text-green-700 text-sm">
												✓ Saved as a tailored resume version + linked to the
												application.
											</span>
										</div>
									</div>
								)}
							</div>
						</div>
					)}
				</DialogContent>
			)}
		</Dialog>
	);
}
