import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";

import App from "./App";
import AuthGate from "./components/AuthGate";
import AgentActivity, { ConnectPage } from "./pages/Activity";
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
import Sources from "./pages/Sources";
import { TriggersPage, ViewsPage } from "./pages/ViewsTriggers";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      // `/` is Overview, not the source list. The cloud login handoff (TARES_LOGIN_URL) lands
      // here, so a customer arrives at the instance at a glance rather than at a table.
      { index: true, element: <Home /> },
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
      { path: "activity", element: <AgentActivity /> },
      { path: "dispatches/:id", element: <DispatchDetail /> },
      { path: "agents", element: <Agents /> },
      { path: "agents/new", element: <AgentNew /> },
      { path: "agents/:name", element: <AgentDetail /> },
      { path: "ask", element: <Ask /> },
      { path: "security", element: <Security /> },
      { path: "settings", element: <Navigate to="/sources" replace /> },
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
