import {
	type IdealJobProfile,
	IdealJobProfileSchema,
	type ProfileCriterion,
	ProfileVersionSchema,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { apiGet, apiSend } from "@/lib/api";

const ProfileNullable = ProfileVersionSchema.nullable();
const RescoreSchema = z.object({ enqueued: z.number().int() });

const EMPTY: IdealJobProfile = {
	northStar: "",
	hardFilters: { compFloor: null, locationRule: "", remoteRequired: false },
	criteria: [{ name: "", weight: 3, description: "" }],
};

// Drop the version metadata to get back the editable profile content.
function toDraft(p: {
	northStar: string;
	hardFilters: IdealJobProfile["hardFilters"];
	criteria: ProfileCriterion[];
}): IdealJobProfile {
	return {
		northStar: p.northStar,
		hardFilters: p.hardFilters,
		criteria: p.criteria,
	};
}

const inputCls =
	"w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";

export function ProfilePage() {
	const queryClient = useQueryClient();
	const [notes, setNotes] = useState("");
	const [draft, setDraft] = useState<IdealJobProfile | null>(null);
	const [savedMsg, setSavedMsg] = useState<string | null>(null);
	const [rescoreMsg, setRescoreMsg] = useState<string | null>(null);

	const profileQ = useQuery({
		queryKey: ["profile"],
		queryFn: () => apiGet("/api/profile", ProfileNullable),
	});

	// Seed the editable form once, when the active profile (or its absence) loads.
	useEffect(() => {
		if (draft === null && profileQ.isSuccess) {
			setDraft(profileQ.data ? toDraft(profileQ.data) : EMPTY);
		}
	}, [profileQ.isSuccess, profileQ.data, draft]);

	const propose = useMutation({
		mutationFn: () =>
			apiSend("/api/profile/propose", "POST", { notes }, IdealJobProfileSchema),
		onSuccess: (data) => {
			setDraft(data); // overwrite the form with the AI draft to edit
			setSavedMsg(null);
		},
	});

	const save = useMutation({
		mutationFn: (profile: IdealJobProfile) =>
			apiSend("/api/profile", "POST", profile, ProfileVersionSchema),
		onSuccess: (saved) => {
			queryClient.invalidateQueries({ queryKey: ["profile"] });
			setSavedMsg(`Saved as v${saved.version} (now active).`);
		},
	});

	const rescore = useMutation({
		mutationFn: () =>
			apiSend("/api/profile/rescore", "POST", {}, RescoreSchema),
		onSuccess: (res) => {
			queryClient.invalidateQueries({ queryKey: ["triage"] });
			setRescoreMsg(
				`Queued ${res.enqueued} posting(s). Run "pnpm --filter api score:drain" to re-score against this profile.`,
			);
		},
	});

	// Immutable draft updaters.
	const patch = (p: Partial<IdealJobProfile>) =>
		setDraft((d) => (d ? { ...d, ...p } : d));
	const patchFilters = (f: Partial<IdealJobProfile["hardFilters"]>) =>
		setDraft((d) =>
			d ? { ...d, hardFilters: { ...d.hardFilters, ...f } } : d,
		);
	const patchCriterion = (i: number, c: Partial<ProfileCriterion>) =>
		setDraft((d) =>
			d
				? {
						...d,
						criteria: d.criteria.map((x, j) => (j === i ? { ...x, ...c } : x)),
					}
				: d,
		);

	return (
		<div className="max-w-3xl space-y-5">
			<div>
				<h2 className="font-semibold text-2xl">Ideal Job Profile</h2>
				<p className="text-slate-500 text-sm">
					The rubric the scorer grades every posting against. Draft one with AI,
					edit it, and save — saving creates a new version and re-scoring
					applies it.
					{profileQ.data && (
						<span className="ml-1 text-slate-400">
							Active: v{profileQ.data.version}.
						</span>
					)}
				</p>
			</div>

			{/* AI draft box */}
			<Card>
				<CardContent className="space-y-2 p-4">
					<label
						htmlFor="notes"
						className="block font-medium text-slate-600 text-sm"
					>
						Notes for the AI (what are you looking for?)
					</label>
					<textarea
						id="notes"
						rows={3}
						className={inputCls}
						placeholder="e.g. Remote-only, applied-AI / AI-enablement IC role, comp floor ~$140k, no CS degree…"
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
					/>
					<Button
						variant="outline"
						size="sm"
						disabled={propose.isPending}
						onClick={() => propose.mutate()}
					>
						{propose.isPending ? "Drafting…" : "✨ Propose with AI"}
					</Button>
					{propose.isError && (
						<p className="text-red-600 text-xs">
							Draft failed — is the API key set?
						</p>
					)}
				</CardContent>
			</Card>

			{draft && (
				<div className="space-y-5">
					{/* North star */}
					<div className="space-y-1">
						<label
							htmlFor="northStar"
							className="block font-medium text-slate-600 text-sm"
						>
							North star
						</label>
						<textarea
							id="northStar"
							rows={3}
							className={inputCls}
							value={draft.northStar}
							onChange={(e) => patch({ northStar: e.target.value })}
						/>
					</div>

					{/* Hard filters */}
					<div>
						<h3 className="mb-2 font-medium text-slate-600 text-sm">
							Hard filters (dealbreakers)
						</h3>
						<div className="grid gap-3 sm:grid-cols-3">
							<div className="space-y-1">
								<label
									htmlFor="compFloor"
									className="block text-slate-500 text-xs"
								>
									Comp floor (USD)
								</label>
								<input
									id="compFloor"
									type="number"
									className={inputCls}
									value={draft.hardFilters.compFloor ?? ""}
									onChange={(e) =>
										patchFilters({
											compFloor:
												e.target.value === "" ? null : Number(e.target.value),
										})
									}
								/>
							</div>
							<div className="space-y-1">
								<label
									htmlFor="locationRule"
									className="block text-slate-500 text-xs"
								>
									Location rule
								</label>
								<input
									id="locationRule"
									className={inputCls}
									value={draft.hardFilters.locationRule}
									onChange={(e) =>
										patchFilters({ locationRule: e.target.value })
									}
								/>
							</div>
							<label className="flex items-end gap-2 pb-2 text-slate-600 text-sm">
								<input
									type="checkbox"
									checked={draft.hardFilters.remoteRequired}
									onChange={(e) =>
										patchFilters({ remoteRequired: e.target.checked })
									}
								/>
								Remote required
							</label>
						</div>
					</div>

					{/* Criteria */}
					<div>
						<div className="mb-2 flex items-center justify-between">
							<h3 className="font-medium text-slate-600 text-sm">
								Weighted criteria
							</h3>
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									patch({
										criteria: [
											...draft.criteria,
											{ name: "", weight: 3, description: "" },
										],
									})
								}
							>
								+ Add criterion
							</Button>
						</div>
						<div className="space-y-2">
							{draft.criteria.map((c, i) => (
								// Positional key is fine here: rows are fully controlled (value
								// comes from `draft`, no internal DOM state to corrupt on reorder),
								// and ProfileCriterion has no stable id to key on.
								// biome-ignore lint/suspicious/noArrayIndexKey: controlled positional rows
								<Card key={i}>
									<CardContent className="grid gap-2 p-3 sm:grid-cols-[1fr_auto]">
										<div className="grid gap-2 sm:grid-cols-[1fr_5rem]">
											<input
												className={inputCls}
												placeholder="Name"
												value={c.name}
												onChange={(e) =>
													patchCriterion(i, { name: e.target.value })
												}
											/>
											<select
												className={inputCls}
												value={c.weight}
												onChange={(e) =>
													patchCriterion(i, { weight: Number(e.target.value) })
												}
											>
												{[1, 2, 3, 4, 5].map((w) => (
													<option key={w} value={w}>
														w{w}
													</option>
												))}
											</select>
											<input
												className={`${inputCls} sm:col-span-2`}
												placeholder="What a strong match looks like"
												value={c.description}
												onChange={(e) =>
													patchCriterion(i, { description: e.target.value })
												}
											/>
										</div>
										<Button
											variant="ghost"
											size="sm"
											className="text-red-600"
											onClick={() =>
												patch({
													criteria: draft.criteria.filter((_, j) => j !== i),
												})
											}
										>
											Remove
										</Button>
									</CardContent>
								</Card>
							))}
						</div>
					</div>

					{/* Actions */}
					<div className="flex flex-wrap items-center gap-3">
						<Button
							disabled={save.isPending}
							onClick={() => save.mutate(draft)}
						>
							{save.isPending ? "Saving…" : "Save profile"}
						</Button>
						<Button
							variant="outline"
							disabled={rescore.isPending}
							onClick={() => rescore.mutate()}
						>
							{rescore.isPending ? "Queuing…" : "Re-score open candidates"}
						</Button>
						{savedMsg && (
							<span className="text-green-700 text-sm">{savedMsg}</span>
						)}
						{rescoreMsg && (
							<span className="text-slate-500 text-sm">{rescoreMsg}</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
