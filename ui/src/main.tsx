import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";

import App from "./App";
import AuthGate from "./components/AuthGate";
import AgentActivity, { ConnectPage } from "./pages/Activity";
import Ask from "./pages/Ask";
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
import Settings from "./pages/Settings";
import Sources from "./pages/Sources";
import { TriggersPage, ViewsPage } from "./pages/ViewsTriggers";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Sources /> },
      { path: "sources/discover", element: <SourceDiscover /> },
      { path: "sources/claude-code", element: <SourceClaudeCode /> },
      { path: "sources/new", element: <SourceNew /> },
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
      { path: "agents", element: <Navigate to="/connect" replace /> },
      { path: "ask", element: <Ask /> },
      { path: "security", element: <Security /> },
      { path: "settings", element: <Settings /> },
      // legacy paths → new homes (bookmarks, the old Entities/Activity/Catalog nav). Catalog
      // dissolved: source schema/freshness now lives on the source detail; the agent's-eye read
      // is Explore's Agent-view toggle.
      { path: "entities", element: <Navigate to="/explore" replace /> },
      { path: "catalog", element: <Navigate to="/" replace /> },
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
