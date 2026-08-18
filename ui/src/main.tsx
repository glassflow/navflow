import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";

import App from "./App";
import AuthGate from "./components/AuthGate";
import AgentActivity, { ConnectPage } from "./pages/Activity";
import Deliveries from "./pages/Deliveries";
import Agents from "./pages/Agents";
import AgentDetail from "./pages/AgentDetail";
import AgentNew from "./pages/AgentNew";
import Ask from "./pages/Ask";
import CatalogExport from "./pages/CatalogExport";
import CatalogImport from "./pages/CatalogImport";
import DispatchDetail from "./pages/DispatchDetail";
import Explore from "./pages/Explore";
import SourceClaudeCode from "./pages/SourceClaudeCode";
import SourceDetail from "./pages/SourceDetail";
import ViewDetail from "./pages/ViewDetail";
import ViewNew from "./pages/ViewNew";
import TriggerDetail from "./pages/TriggerDetail";
import TriggerNew from "./pages/TriggerNew";
import SourceDiscover from "./pages/SourceDiscover";
import SourceNew from "./pages/SourceNew";
import Security from "./pages/Security";
import Home from "./pages/Home";
import McpServers from "./pages/McpServers";
import Sources from "./pages/Sources";
import { TriggersPage, ViewsPage } from "./pages/ViewsTriggers";
import Usecases from "./pages/Usecases";
import UsecaseDetail from "./pages/UsecaseDetail";
import UsecaseNewGeneric from "./pages/UsecaseNewGeneric";
import UsecaseNewSharedContext from "./pages/UsecaseNewSharedContext";
import "./styles.css";

/** /activity?tab=dispatches (and the bare page, whose default tab was dispatches) → Deliveries;
 *  /activity?tab=queries → Reads; ?agent=… → the subscriber roster on Deliveries. */
function ActivityRedirect() {
  const q = new URLSearchParams(window.location.search);
  if (q.get("tab") === "queries") return <Navigate to="/reads" replace />;
  const agent = q.get("agent");
  return <Navigate to={agent ? `/deliveries?agent=${encodeURIComponent(agent)}` : "/deliveries"} replace />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      // `/` is Overview, not the source list. The cloud login handoff (TARES_LOGIN_URL) lands
      // here, so a customer arrives at the instance at a glance rather than at a table.
      { index: true, element: <Home /> },
      { path: "usecases", element: <Usecases /> },
      { path: "usecases/new/shared_code_context", element: <UsecaseNewSharedContext /> },
      { path: "usecases/new/:recipe", element: <UsecaseNewGeneric /> },
      { path: "usecases/:id", element: <UsecaseDetail /> },
      { path: "sources", element: <Sources /> },
      { path: "sources/discover", element: <SourceDiscover /> },
      { path: "sources/claude-code", element: <SourceClaudeCode /> },
      { path: "sources/new", element: <SourceNew /> },
      { path: "sources/export", element: <CatalogExport /> },
      { path: "sources/import", element: <CatalogImport /> },
      { path: "sources/:name", element: <SourceDetail /> },
      { path: "organize", element: <Navigate to="/ask" replace /> },
      { path: "explore", element: <Explore /> },
      { path: "views", element: <ViewsPage /> },
      { path: "views/new", element: <ViewNew /> },
      { path: "views/:name", element: <ViewDetail /> },
      { path: "triggers", element: <TriggersPage /> },
      { path: "triggers/new", element: <TriggerNew /> },
      { path: "triggers/:name", element: <TriggerDetail /> },
      { path: "connect", element: <ConnectPage /> },
      { path: "reads", element: <AgentActivity /> },
      { path: "deliveries", element: <Deliveries /> },
      // TR-137 renames: /activity split into /reads + /deliveries (dispatches live with their
      // subscribers now); /security is /settings.
      { path: "activity", element: <ActivityRedirect /> },
      { path: "security", element: <Navigate to="/settings" replace /> },
      { path: "dispatches/:id", element: <DispatchDetail /> },
      { path: "agents", element: <Agents /> },
      { path: "mcp-servers", element: <McpServers /> },
      { path: "agents/new", element: <AgentNew /> },
      { path: "agents/:name", element: <AgentDetail /> },
      { path: "ask", element: <Ask /> },
      { path: "settings", element: <Security /> },
      // legacy paths → new homes (bookmarks, the old Entities/Activity/Catalog nav). Catalog
      // dissolved: source schema/freshness now lives on the source detail; the agent's-eye read
      // is Explore's Agent-view toggle.
      { path: "entities", element: <Navigate to="/explore" replace /> },
      // These two meant "the source list" when `/` was the source list — they still do.
      { path: "catalog", element: <Navigate to="/sources" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <RouterProvider router={router} />
    </AuthGate>
  </React.StrictMode>,
);
