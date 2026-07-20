import {
	type AiModelSettings,
	AiModelSettingsResponseSchema,
	AiModelSettingsSchema,
	ModelsCatalogSchema,
	ModelsUsageSchema,
	type OpenRouterModel,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { apiGet, apiSend } from "@/lib/api";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// ModelsPage — pick which OpenRouter model serves each tier, with live
// pricing, then watch what the choice actually costs in the usage table.
//
// Selection state lives page-local as a *draft* keyed by tier; the effective
// config (saved settings, else the api's defaults) is what the draft is diffed
// against to enable Save. The catalog is hundreds of rows, so each tier card
// filters it client-side through a text input — no giant <select>.
// ---------------------------------------------------------------------------

/** What each tier is for, plus a "typical call" to make prices concrete. */
const TIERS = [
	{
		key: "small" as const,
		title: "Small — bulk scoring",
		blurb: "Dozens of postings per poll; cost matters.",
		perCall: { inTok: 3_000, outTok: 300, label: "per scored posting" },
	},
	{
		key: "large" as const,
		title: "Large — quality work",
		blurb:
			"Tailor, resume review, profile synthesis; one human-gated call at a time.",
		perCall: { inTok: 5_000, outTok: 3_000, label: "per tailor run" },
	},
];

function fmtPrice(perMTok: number): string {
	return `$${perMTok.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function fmtContext(len: number | null): string {
	if (len === null) return "?";
	return len >= 1000 ? `${Math.round(len / 1000)}k` : String(len);
}

/** ≈ USD for one typical call of this tier at this model's prices. */
function costPerCall(
	m: OpenRouterModel,
	perCall: { inTok: number; outTok: number },
): string {
	const usd =
		(perCall.inTok / 1e6) * m.promptPerMTok +
		(perCall.outTok / 1e6) * m.completionPerMTok;
	return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`;
}

/** Filter input + scrollable row list over the whole catalog for one tier. */
function ModelPicker({
	models,
	selectedId,
	onSelect,
}: {
	models: OpenRouterModel[];
	selectedId: string;
	onSelect: (id: string) => void;
}) {
	const [filter, setFilter] = useState("");
	const shown = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return models;
		return models.filter(
			(m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
		);
	}, [models, filter]);

	return (
		<div className="space-y-2">
			<input
				type="text"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				placeholder={`Filter ${models.length} models…`}
				className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400"
			/>
			<ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
				{shown.map((m) => (
					<li key={m.id}>
						<button
							type="button"
							onClick={() => onSelect(m.id)}
							className={cn(
								"flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50",
								m.id === selectedId && "bg-slate-100 font-medium",
							)}
						>
							<span className="min-w-0">
								<span className="block truncate">{m.name}</span>
								<span className="block truncate font-mono text-slate-400 text-xs">
									{m.id}
								</span>
							</span>
							<span className="shrink-0 text-slate-500 text-xs tabular-nums">
								{fmtPrice(m.promptPerMTok)}/{fmtPrice(m.completionPerMTok)} MTok
								· {fmtContext(m.contextLength)}
							</span>
						</button>
					</li>
				))}
				{shown.length === 0 && (
					<li className="px-3 py-2 text-slate-400 text-sm">No matches.</li>
				)}
			</ul>
		</div>
	);
}

export function ModelsPage() {
	const queryClient = useQueryClient();

	const catalogQ = useQuery({
		queryKey: ["models-catalog"],
		queryFn: () => apiGet("/api/models", ModelsCatalogSchema),
	});
	const settingsQ = useQuery({
		queryKey: ["ai-model-settings"],
		queryFn: () =>
			apiGet("/api/settings/ai-models", AiModelSettingsResponseSchema),
	});
	const usageQ = useQuery({
		queryKey: ["models-usage"],
		queryFn: () => apiGet("/api/models/usage", ModelsUsageSchema),
	});

	// Saved settings win; the api's defaults fill in before the first save.
	const effective: AiModelSettings | null = settingsQ.data
		? (settingsQ.data.settings ?? settingsQ.data.defaults)
		: null;
	const isDefault = settingsQ.data ? settingsQ.data.settings === null : false;

	// The draft holds only *changed* tiers; effective fills the rest. This makes
	// "did anything change?" a simple comparison and survives refetches.
	const [draft, setDraft] = useState<Partial<AiModelSettings>>({});
	const selection: AiModelSettings | null = effective
		? { ...effective, ...draft }
		: null;
	const dirty =
		effective !== null &&
		selection !== null &&
		(selection.small !== effective.small ||
			selection.large !== effective.large);

	const [savedMsg, setSavedMsg] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (value: AiModelSettings) =>
			apiSend("/api/settings/ai-models", "PUT", value, AiModelSettingsSchema),
		onSuccess: (saved) => {
			queryClient.invalidateQueries({ queryKey: ["ai-model-settings"] });
			setDraft({});
			setSavedMsg(`Saved: ${saved.small} / ${saved.large}`);
		},
		onError: (err) => {
			// A 400 here names the offending slug (stale catalog entry).
			toastError(err instanceof Error ? err.message : "save failed");
		},
	});

	const modelById = useMemo(
		() => new Map(catalogQ.data?.models.map((m) => [m.id, m]) ?? []),
		[catalogQ.data],
	);

	return (
		<div className="max-w-3xl space-y-5">
			<div>
				<h2 className="font-semibold text-2xl">AI Models</h2>
				<p className="text-slate-500 text-sm">
					Which OpenRouter model serves each tier — browse the live catalog,
					compare prices, and see what your choices actually cost below.
				</p>
			</div>

			{settingsQ.data && settingsQ.data.activeProvider !== "openrouter" && (
				<div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 text-sm">
					AI_PROVIDER is <code>{settingsQ.data.activeProvider}</code> —
					selections below take effect when it's set to <code>openrouter</code>{" "}
					in <code>.env</code>.
				</div>
			)}

			{(catalogQ.isPending || settingsQ.isPending) && (
				<p className="text-slate-500">Loading catalog…</p>
			)}
			{catalogQ.isError && (
				<p className="text-red-600">
					Failed to load the OpenRouter catalog.{" "}
					{catalogQ.error instanceof Error ? catalogQ.error.message : ""}
				</p>
			)}

			{catalogQ.data && selection && (
				<div className="grid gap-4 lg:grid-cols-2">
					{TIERS.map((tier) => {
						const current = modelById.get(selection[tier.key]);
						return (
							<Card key={tier.key}>
								<CardContent className="space-y-3 p-4">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{tier.title}</span>
										{isDefault && draft[tier.key] === undefined && (
											<Badge variant="neutral">default</Badge>
										)}
									</div>
									<p className="text-slate-500 text-sm">{tier.blurb}</p>

									<div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
										{current ? (
											<>
												<div className="flex items-baseline justify-between gap-2">
													<span className="truncate font-medium">
														{current.name}
													</span>
													<span className="shrink-0 text-slate-500 text-xs tabular-nums">
														{fmtPrice(current.promptPerMTok)} in /{" "}
														{fmtPrice(current.completionPerMTok)} out per MTok ·{" "}
														{fmtContext(current.contextLength)} ctx
													</span>
												</div>
												<div className="font-mono text-slate-400 text-xs">
													{selection[tier.key]}
												</div>
												<div className="text-slate-500 text-xs">
													≈ {costPerCall(current, tier.perCall)}{" "}
													{tier.perCall.label}
												</div>
											</>
										) : (
											// Saved slug no longer in the catalog (delisted model).
											<span className="font-mono text-amber-700 text-xs">
												{selection[tier.key]} — not in the current catalog
											</span>
										)}
									</div>

									<ModelPicker
										models={catalogQ.data.models}
										selectedId={selection[tier.key]}
										onSelect={(id) =>
											setDraft((d) => ({ ...d, [tier.key]: id }))
										}
									/>
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}

			{selection && (
				<div className="flex items-center gap-3">
					<Button
						disabled={!dirty || save.isPending}
						onClick={() => selection && save.mutate(selection)}
					>
						{save.isPending ? "Saving…" : "Save"}
					</Button>
					{!dirty && savedMsg && (
						<span className="text-green-700 text-sm">{savedMsg}</span>
					)}
				</div>
			)}

			<div className="space-y-2">
				<h3 className="font-medium text-lg">Usage</h3>
				<p className="text-slate-500 text-sm">
					Actual calls and spend per model, from the ai_runs ledger — newest
					first.
				</p>
				{usageQ.data && usageQ.data.usage.length === 0 && (
					<p className="text-slate-400 text-sm">No AI calls logged yet.</p>
				)}
				{usageQ.data && usageQ.data.usage.length > 0 && (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Model</TableHead>
								<TableHead className="text-right">Calls</TableHead>
								<TableHead className="text-right">Tokens in/out</TableHead>
								<TableHead className="text-right">Total cost</TableHead>
								<TableHead className="text-right">Last used</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{usageQ.data.usage.map((u) => (
								<TableRow key={u.model}>
									<TableCell className="font-mono text-xs">{u.model}</TableCell>
									<TableCell className="text-right tabular-nums">
										{u.calls.toLocaleString()}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{u.inputTokens.toLocaleString()} /{" "}
										{u.outputTokens.toLocaleString()}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{u.totalCostUsd === null
											? "—"
											: `$${u.totalCostUsd.toFixed(4)}`}
									</TableCell>
									<TableCell className="text-right text-slate-500 text-xs">
										{new Date(u.lastUsedAt).toLocaleString()}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</div>
	);
}
