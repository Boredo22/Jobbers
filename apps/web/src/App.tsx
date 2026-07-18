import { Route, Routes } from "react-router-dom";
import { HealthBadge } from "@/components/HealthBadge";

function Home() {
	return (
		<main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 p-8">
			<h1 className="font-bold text-4xl tracking-tight">Jobber</h1>
			<p className="text-gray-500">Self-hosted job-search dashboard</p>
			<HealthBadge />
		</main>
	);
}

export default function App() {
	return (
		<Routes>
			<Route path="/" element={<Home />} />
		</Routes>
	);
}
