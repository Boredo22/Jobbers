import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import { HealthBadge } from "./HealthBadge";

// The nav items, data-driven so the markup is a single map instead of repeated
// JSX. Add a page here + a <Route> in App.tsx and it appears in the sidebar.
const NAV = [
	{ to: "/triage", label: "Triage" },
	{ to: "/jobs", label: "Jobs" },
	{ to: "/companies", label: "Companies" },
	{ to: "/pipeline", label: "Pipeline" },
];

// Layout is the app shell: a fixed sidebar plus a content area. <Outlet/> is
// React Router's "render the matched child route here" slot — the page for the
// current URL is injected in its place, while the sidebar stays put across
// navigations (no full reload, no re-mounting the shell).
export function Layout() {
	return (
		<div className="flex min-h-screen bg-slate-50 text-slate-900">
			<aside className="flex w-56 flex-col border-slate-200 border-r bg-white">
				<div className="p-4">
					<h1 className="font-bold text-xl tracking-tight">Jobber</h1>
					<p className="text-slate-400 text-xs">job-search dashboard</p>
				</div>
				<nav className="flex flex-col gap-1 px-2">
					{NAV.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							// NavLink gives us an isActive flag so the current page's link
							// can highlight itself — the router tracks which route matches.
							className={({ isActive }) =>
								cn(
									"rounded-md px-3 py-2 font-medium text-sm transition-colors",
									isActive
										? "bg-slate-900 text-white"
										: "text-slate-600 hover:bg-slate-100",
								)
							}
						>
							{item.label}
						</NavLink>
					))}
				</nav>
				<div className="mt-auto p-4">
					<HealthBadge />
				</div>
			</aside>

			<main className="flex-1 overflow-x-hidden p-6">
				<Outlet />
			</main>
		</div>
	);
}
