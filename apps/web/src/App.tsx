import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { CompaniesPage } from "@/pages/CompaniesPage";
import { JobsPage } from "@/pages/JobsPage";
import { PipelinePage } from "@/pages/PipelinePage";
import { ProfilePage } from "@/pages/ProfilePage";
import { TriagePage } from "@/pages/TriagePage";

// The route table. The parent <Route element={<Layout/>}> renders the sidebar
// shell; its children render into the <Outlet/> inside Layout. `index` makes
// "/" redirect to the jobs page — the app's default landing view.
export default function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<Navigate to="/triage" replace />} />
				<Route path="/triage" element={<TriagePage />} />
				<Route path="/jobs" element={<JobsPage />} />
				<Route path="/companies" element={<CompaniesPage />} />
				<Route path="/pipeline" element={<PipelinePage />} />
				<Route path="/profile" element={<ProfilePage />} />
			</Route>
		</Routes>
	);
}
