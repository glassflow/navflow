import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { auth } from "./api";
import CommandPalette from "./components/CommandPalette";
import {
  Activity, Bolt, Book, Chat, ChevronRight, Database, Lock, Moon,
  Settings as SettingsIco, SignOut, Sun, Terminal,
} from "./components/icons";
import { applyTheme, currentTheme, type Theme } from "./theme";

const link = ({ isActive }: { isActive: boolean }) => "navlink" + (isActive ? " active" : "");

type NavItem = {
  to: string;
  end?: boolean;
  label: string;
  icon: (p: { className?: string }) => JSX.Element;
  badge?: string;   // small uppercase tag, e.g. "beta"
  locked?: boolean; // shows a lock glyph for gated features
};

// The nav is the product story, in three acts: data in → the timeline → serve to agents.
const NAV_GROUPS: { section: string; items: NavItem[] }[] = [
  { section: "Data in", items: [
    { to: "/", end: true, label: "Sources", icon: Database },
  ] },
  { section: "The timeline", items: [
    { to: "/explore", label: "Explore", icon: Activity },
  ] },
  { section: "Serve to agents", items: [
    { to: "/views", label: "Views", icon: Book },
    { to: "/triggers", label: "Triggers", icon: Bolt },
    { to: "/agents", label: "Agents", icon: Terminal },
  ] },
];

const SECTION_LABEL: Record<string, string> = {
  explore: "Explore",
  views: "Views",
  triggers: "Triggers",
  agents: "Agents",
  catalog: "Catalog",
  ask: "Ask",
  settings: "Settings",
};

type Crumb = { label: string; to?: string; mono?: boolean };

/** Derive breadcrumbs from the current path. Sources is the root section, so its
 *  second-level pages (/sources/:name, /new, /discover) link back to the list. */
function useCrumbs(): Crumb[] {
  const { pathname } = useLocation();
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

  if (parts.length === 0) return [{ label: "Sources" }];

  if (parts[0] === "sources") {
    if (parts.length === 1) return [{ label: "Sources" }];
    const sub = decodeURIComponent(parts[1]);
    const last: Crumb =
      sub === "discover" ? { label: "Auto-discover" }
      : sub === "new" ? { label: "Add source" }
      : sub === "claude-code" ? { label: "Claude Code" }
      : { label: sub, mono: true };
    return [{ label: "Sources", to: "/" }, last];
  }

  return [{ label: SECTION_LABEL[parts[0]] ?? parts[0] }];
}

function Breadcrumbs() {
  const crumbs = useCrumbs();
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span className="crumb" key={i}>
            {i > 0 && <span className="sep"><ChevronRight className="ico" /></span>}
            {c.to && !last
              ? <Link to={c.to}>{c.label}</Link>
              : <span className={"cur" + (c.mono ? " mono" : "")}>{c.label}</span>}
          </span>
        );
      })}
    </nav>
  );
}

function signOut() {
  auth.clear();
  window.location.reload();
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };
  return (
    <button className="navbtn" onClick={toggle} title="Toggle light / dark">
      {theme === "dark" ? <Sun /> : <Moon />}
      <span className="nav-label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}

export default function App() {
  return (
    <>
      <nav className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/navflow-mark.svg" alt="NavFlow" />
          <span className="brand-word">nav<em>flow</em><small>console</small></span>
        </div>

        {NAV_GROUPS.map(({ section, items }) => (
          <div className="nav-group" key={section}>
            <div className="nav-section">{section}</div>
            {items.map(({ to, end, label, icon: Icon, badge, locked }) => (
              <NavLink key={to} to={to} end={end} className={link}>
                <Icon className="ico" />
                <span className="nav-label">{label}</span>
                {badge && <span className="nav-badge">{badge}</span>}
                {locked && <Lock className="nav-lock" />}
              </NavLink>
            ))}
          </div>
        ))}

        <div className="nav-spacer" />
        <div className="sep" />

        <NavLink to="/ask" className={link}>
          <Chat className="ico" />
          <span className="nav-label">Ask</span>
          <kbd className="nav-kbd" title="Ask from anywhere">⌘K</kbd>
        </NavLink>
        <NavLink to="/settings" className={link}>
          <SettingsIco className="ico" />
          <span className="nav-label">Settings</span>
        </NavLink>
        <ThemeToggle />
        {auth.get() && (
          <button className="navbtn" onClick={signOut}>
            <SignOut className="ico" />
            <span className="nav-label">Sign out</span>
          </button>
        )}
        <div className="foot">
          one project, all sources ·{" "}
          <a href="/docs" target="_blank" rel="noreferrer">API</a>
        </div>
      </nav>

      <div className="content">
        <header className="topbar">
          <Breadcrumbs />
        </header>
        <main className="main">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
    </>
  );
}
