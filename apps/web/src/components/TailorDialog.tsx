import {
	type TailoredDraft,
	TailoredDraftRecordSchema,
	TailoredDraftSchema,
	type TriageItem,
} from "@jobber/shared";
import { useMutation } from "@tanstack/react-query";
import { diffWords } from "diff";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { apiSend } from "@/lib/api";

// ---------------------------------------------------------------------------
// TailorDialog — the tailor-to-posting flow (step 3.2b), opened from a triage
// card. Generate AI resume edits + a draft outreach note for THIS posting, show
// the edits as before/after word diffs, let the human finish the outreach note,
// and save the result as a draft attached to the application.
// ---------------------------------------------------------------------------

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

export function TailorDialog({
	item,
	onClose,
}: {
	item: TriageItem | null;
	onClose: () => void;
}) {
	// The current draft (starts as the model's output; the outreach note is then
	// human-editable before saving). State resets automatically when a different
	// posting is opened because the parent remounts this component via `key` —
	// cleaner than a reset-on-prop-change effect.
	const [draft, setDraft] = useState<TailoredDraft | null>(null);
	const [saved, setSaved] = useState(false);

	const generate = useMutation({
		mutationFn: (jobPostingId: string) =>
			apiSend(
				`/api/postings/${jobPostingId}/tailor`,
				"POST",
				{},
				TailoredDraftSchema,
			),
		onSuccess: (data) => {
			setDraft(data);
			setSaved(false);
		},
	});

	const save = useMutation({
		mutationFn: (vars: { jobPostingId: string; body: TailoredDraft }) =>
			apiSend(
				`/api/postings/${vars.jobPostingId}/tailor/save`,
				"POST",
				vars.body,
				TailoredDraftRecordSchema,
			),
		onSuccess: () => setSaved(true),
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

					{!draft && (
						<div className="mt-4">
							<Button
								disabled={generate.isPending}
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
									disabled={save.isPending}
									onClick={() =>
										save.mutate({
											jobPostingId: item.jobPostingId,
											body: draft,
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
						</div>
					)}
				</DialogContent>
			)}
		</Dialog>
	);
}
