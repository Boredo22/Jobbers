import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import "./index.css";

// One QueryClient for the whole app. It owns the cache of server data:
// dedupes requests, caches by queryKey, and handles background refetching.
const queryClient = new QueryClient();

// biome-ignore lint/style/noNonNullAssertion: index.html always has #root
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* Providers wrap the whole tree so any component can use these features. */}
		<QueryClientProvider client={queryClient}>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</QueryClientProvider>
	</StrictMode>,
);
