import {
	ResumeDetailSchema,
	type ResumeReview,
	ResumeReviewSchema,
	ResumeVersionSchema,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { apiGet, apiSend } from "@/lib/api";

const ResumeListSchema = z.array(ResumeVersionSchema);
const OkSchema = z.object({ ok: z.literal(true) });

function fmtDate(d: Date): string {
	return new Date(d).toLocaleDateString();
}

// A titled list of bullet strings — the review's repeated shape.
function ReviewList({ title, items }: { title: string; items: string[] }) {
	if (items.length === 0) return null;
	return (
		<div>
			<h4 className="font-medium text-slate-600 text-sm">{title}</h4>
			<ul className="mt-1 space-y-1">
				{items.map((it) => (
					<li key={it} className="text-slate-700 text-sm">
						• {it}
					</li>
				))}
			</ul>
		</div>
	);
}

export function ResumePage() {
	const queryClient = useQueryClient();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [review, setReview] = useState<ResumeReview | null>(null);
	const [uploadErr, setUploadErr] = useState<string | null>(null);

	const list = useQuery({
		queryKey: ["resumes"],
		queryFn: () => apiGet("/api/resumes", ResumeListSchema),
	});

	const detail = useQuery({
		queryKey: ["resume", selectedId],
		queryFn: () => apiGet(`/api/resumes/${selectedId}`, ResumeDetailSchema),
		enabled: selectedId !== null,
	});

	// Multipart upload — a raw fetch (apiSend is JSON-only), still Zod-validated.
	const upload = useMutation({
		mutationFn: async (file: File) => {
			const fd = new FormData();
			fd.append("file", file);
			const res = await fetch("/api/resumes", { method: "POST", body: fd });
			const json = await res.json();
			if (!res.ok)
				throw new Error(json?.message ?? `upload failed (${res.status})`);
			return ResumeVersionSchema.parse(json);
		},
		onSuccess: () => {
			setUploadErr(null);
			queryClient.invalidateQueries({ queryKey: ["resumes"] });
		},
		onError: (e) =>
			setUploadErr(e instanceof Error ? e.message : "upload failed"),
	});

	const activate = useMutation({
		mutationFn: (id: string) =>
			apiSend(`/api/resumes/${id}/activate`, "POST", {}, OkSchema),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resumes"] }),
	});

	const runReview = useMutation({
		mutationFn: (id: string) =>
			apiSend(`/api/resumes/${id}/review`, "POST", {}, ResumeReviewSchema),
		onSuccess: (data) => setReview(data),
	});

	const openDialog = (id: string) => {
		setReview(null);
		runReview.reset();
		setSelectedId(id);
	};

	return (
		<div className="max-w-3xl space-y-5">
			<div>
				<h2 className="font-semibold text-2xl">Resume</h2>
				<p className="text-slate-500 text-sm">
					Upload a resume (PDF / DOCX / TXT). The active version's text feeds
					the scorer and the profile drafter. Open one to read its extracted
					text or get an AI review against your active profile.
				</p>
			</div>

			{/* Upload */}
			<Card>
				<CardContent className="flex flex-wrap items-center gap-3 p-4">
					<input
						type="file"
						accept=".pdf,.docx,.txt,.md"
						className="text-sm"
						disabled={upload.isPending}
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) upload.mutate(file);
							e.target.value = ""; // allow re-uploading the same filename
						}}
					/>
					{upload.isPending && (
						<span className="text-slate-500 text-sm">Uploading…</span>
					)}
					{uploadErr && (
						<span className="text-red-600 text-sm">{uploadErr}</span>
					)}
				</CardContent>
			</Card>

			{list.isPending && <p className="text-slate-500">Loading…</p>}
			{list.data && list.data.length === 0 && (
				<p className="text-slate-500">No resumes yet — upload one above.</p>
			)}

			<div className="space-y-2">
				{list.data?.map((rv) => (
					<Card key={rv.id}>
						<CardContent className="flex flex-wrap items-center gap-3 p-3">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate font-medium text-sm">
										{rv.label}
									</span>
									{rv.active && <Badge variant="green">active</Badge>}
								</div>
								<div className="text-slate-400 text-xs">
									{rv.charCount.toLocaleString()} chars · uploaded{" "}
									{fmtDate(rv.createdAt)}
								</div>
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => openDialog(rv.id)}
							>
								View / Review
							</Button>
							<Button
								size="sm"
								disabled={rv.active || activate.isPending}
								onClick={() => activate.mutate(rv.id)}
							>
								{rv.active ? "Active" : "Set active"}
							</Button>
						</CardContent>
					</Card>
				))}
			</div>

			{/* Detail + review dialog */}
			<Dialog
				open={selectedId !== null}
				onOpenChange={(open) => !open && setSelectedId(null)}
			>
				{selectedId && (
					<DialogContent className="max-h-[85vh] overflow-y-auto">
						<DialogTitle>{detail.data?.label ?? "Resume"}</DialogTitle>
						<DialogDescription>
							{detail.data
								? `${detail.data.charCount.toLocaleString()} chars`
								: "Loading…"}
						</DialogDescription>

						<div className="mt-3">
							<Button
								size="sm"
								disabled={runReview.isPending}
								onClick={() => runReview.mutate(selectedId)}
							>
								{runReview.isPending ? "Reviewing…" : "✨ Review with AI"}
							</Button>
							{runReview.isError && (
								<span className="ml-2 text-red-600 text-xs">
									Review failed — is the API key set?
								</span>
							)}
						</div>

						{review && (
							<div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
								<p className="text-slate-700 text-sm">{review.summary}</p>
								<ReviewList title="Strengths" items={review.strengths} />
								<ReviewList title="Weaknesses" items={review.weaknesses} />
								{review.sectionSuggestions.length > 0 && (
									<div>
										<h4 className="font-medium text-slate-600 text-sm">
											Section suggestions
										</h4>
										<ul className="mt-1 space-y-1">
											{review.sectionSuggestions.map((s) => (
												<li key={s.section} className="text-slate-700 text-sm">
													<span className="font-medium">{s.section}:</span>{" "}
													{s.suggestion}
												</li>
											))}
										</ul>
									</div>
								)}
								<ReviewList title="ATS flags" items={review.atsFlags} />
							</div>
						)}

						<div className="mt-4">
							<h4 className="mb-1 font-medium text-slate-600 text-sm">
								Extracted text
							</h4>
							<pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-3 text-slate-600 text-xs">
								{detail.data?.extractedText ?? ""}
							</pre>
						</div>
					</DialogContent>
				)}
			</Dialog>
		</div>
	);
}
