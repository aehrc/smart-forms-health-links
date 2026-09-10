import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { SmartProvider } from "./auth/SmartContext";
import { ConfigProvider } from "./lib/ConfigContext";
import "./index.css";

/**
 * App-level query client, for forms-server reads. The renderer maintains its own separate client
 * via `useRendererQueryClient` for terminology lookups.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
  },
});

createRoot(document.querySelector("#root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider>
        {/* Inside QueryClientProvider because the session is a query against `/api/session`, and
            outside the router because it is not route-dependent and must survive navigation. It no
            longer needs config: the issuer comes from the session, not from a configured URL. */}
        <SmartProvider>
          {/*
            BrowserRouter, not HashRouter: the URL fragment carries the link payload, so it is not
            available for routing. See src/link/codec.ts.
          */}
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </SmartProvider>
      </ConfigProvider>
    </QueryClientProvider>
  </StrictMode>,
);
