import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";

import App from "./App";
import AuthGate from "./components/AuthGate";
import Activity from "./pages/Activity";
import Ask from "./pages/Ask";
import Explore from "./pages/Explore";
import SourceClaudeCode from "./pages/SourceClaudeCode";
import SourceDetail from "./pages/SourceDetail";
import SourceDiscover from "./pages/SourceDiscover";
import SourceNew from "./pages/SourceNew";
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
      { path: "explore", element: <Explore /> },
      { path: "views", element: <ViewsPage /> },
      { path: "triggers", element: <TriggersPage /> },
      { path: "agents", element: <Activity /> },
      { path: "ask", element: <Ask /> },
      { path: "settings", element: <Settings /> },
      // legacy paths → new homes (bookmarks, the old Entities/Activity/Catalog nav). Catalog
      // dissolved: source schema/freshness now lives on the source detail; the agent's-eye read
      // is Explore's Agent-view toggle.
      { path: "entities", element: <Navigate to="/explore" replace /> },
      { path: "activity", element: <Navigate to="/agents" replace /> },
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
