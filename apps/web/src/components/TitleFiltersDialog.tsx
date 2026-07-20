import {
	type PrefilterSettings,
	PrefilterSettingsSchema,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { apiGet, apiSend } from "@/lib/api";
import { toastError } from "@/lib/toast";

// ---------------------------------------------------------------------------
// TitleFiltersDialog — edit the prefilter's include/exclude title keywords
// from the Jobs page. Saving PUTs the full lists; the Jobs query is then
// invalidated so the candidate badges recompute immediately (the API derives
// `candidate` per request — no re-poll or rebuild needed). Scoring, though,
// only enqueues at first-sight or via backfill, so new keywords need a
// "score candidates" run to reach Triage — the hint under the save button.
// ---------------------------------------------------------------------------

/** One editable keyword list: removable chips + an add box. */
function KeywordListEditor({
	label,
	hint,
	keywords,
	onChange,
}: {
	label: string;
	hint: string;
	keywords: string[];
	onChange: (next: string[]) => void;
}) {
	const [draft, setDraft] = useState("");

	function add(): void {
		const k = draft.trim().toLowerCase();
		setDraft("");
		if (k === "" || keywords.includes(k)) return;
		onChange([...keywords, k]);
	}

	return (
		<div className="space-y-2">
			<div>
				<h3 className="font-medium text-sm">{label}</h3>
				<p className="text-slate-500 text-xs">{hint}</p>
			</div>
			<div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
				{keywords.map((k) => (
					<span
						key={k}
						className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-700 text-xs"
					>
						{k}
						<button
							type="button"
							aria-label={`Remove ${k}`}
							className="text-slate-400 hover:text-red-600"
							onClick={() => onChange(keywords.filter((x) => x !== k))}
						>
							×
						</button>
					</span>
				))}
			</div>
			<div className="flex gap-2">
				<input
					type="text"
					value={draft}
					placeholder="add keyword…"
					className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
					onChange={(e) => setDraft(e.target.value)}
					// Enter adds the chip instead of submitting anything.
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
					}}
				/>
				<Button type="button" variant="outline" size="sm" onClick={add}>
					Add
				</Button>
			</div>
		</div>
	);
}

export function TitleFiltersDialog() {
	const [open, setOpen] = useState(false);
	// Local working copy while editing; null = not yet initialized from the
	// server. Seeded when the query resolves, reset every time the dialog opens.
	const [edited, setEdited] = useState<PrefilterSettings | null>(null);
	const queryClient = useQueryClient();

	const { data: saved } = useQuery({
		queryKey: ["prefilter-settings"],
		queryFn: () => apiGet("/api/settings/prefilter", PrefilterSettingsSchema),
	});

	const save = useMutation({
		mutationFn: (value: PrefilterSettings) =>
			apiSend("/api/settings/prefilter", "PUT", value, PrefilterSettingsSchema),
		onSuccess: (value) => {
			queryClient.setQueryData(["prefilter-settings"], value);
			// Every cached jobs combination is stale now — candidate is derived
			// server-side from these keywords.
			queryClient.invalidateQueries({ queryKey: ["jobs"] });
			setOpen(false);
		},
		onError: () => toastError("Saving title filters failed."),
	});

	// The lists being rendered: local edits once the user touched something,
	// otherwise whatever the server has.
	const value = edited ?? saved ?? null;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setEdited(null); // reopen fresh from the server copy
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					Title filters
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-xl space-y-4">
				<div>
					<DialogTitle>Title filters</DialogTitle>
					<DialogDescription>
						Which posting titles count as candidates. Matching is
						case-insensitive substring, include first, then exclude vetoes.
					</DialogDescription>
				</div>

				{value === null ? (
					<p className="text-slate-500 text-sm">Loading…</p>
				) : (
					<>
						<KeywordListEditor
							label="Include keywords"
							hint="A title must contain at least one of these."
							keywords={value.includeTitleKeywords}
							onChange={(next) =>
								setEdited({ ...value, includeTitleKeywords: next })
							}
						/>
						<KeywordListEditor
							label="Exclude keywords"
							hint="Any of these disqualifies a title, even when an include matches."
							keywords={value.excludeTitleKeywords}
							onChange={(next) =>
								setEdited({ ...value, excludeTitleKeywords: next })
							}
						/>
						<div className="space-y-2">
							<Button
								type="button"
								disabled={
									save.isPending ||
									edited === null ||
									value.includeTitleKeywords.length === 0
								}
								onClick={() => save.mutate(value)}
							>
								{save.isPending ? "Saving…" : "Save filters"}
							</Button>
							<p className="text-slate-500 text-xs">
								Candidate badges update immediately. To get newly matching roles
								scored, run “score candidates” from the Triage page afterwards.
							</p>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
