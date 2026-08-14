import { Navigate, Outlet, Route, Routes, Link, useLocation } from "react-router-dom";
import { useAuth } from "./hooks/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Logo } from "./components/Logo";
import { IconHome, IconPerson } from "./components/Icon";
import { UpdatePrompt } from "./pwa/UpdatePrompt";
import Login from "./pages/Login";
import HouseholdHome from "./pages/HouseholdHome";
import CollectorHome from "./pages/CollectorHome";
import AdminDashboard from "./pages/AdminDashboard";
import Profile from "./pages/Profile";

/**
 * Mounted once as a layout route (below), not per-page — every earlier version wrapped each
 * <Route>'s element in its own <Shell>{children}</Shell>, which meant React Router tore down
 * and rebuilt the whole topbar/tabbar chrome on every navigation between them, including the
 * Home <-> Profile tab switch. That full remount was the actual cause of the visible "jump"
 * users reported (independent of, and on top of, the safe-area padding/height fixes elsewhere)
 * — only the routed page content should change on navigation, not the chrome around it.
 */
function Shell() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const onHome = loc.pathname.startsWith("/household") || loc.pathname.startsWith("/collector");
  const onProfile = loc.pathname === "/profile";
  const wide = loc.pathname.startsWith("/admin");
  return (
    <div className={`app-shell ${wide ? "wide" : ""}`}>
      <div className="topbar">
        <Logo size={28} />
        <span className="spacer" />
        {user && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
            Log out
          </button>
        )}
      </div>
      <Outlet />
      {user && user.role !== "admin" && (
        <div className="tabbar">
          <Link className={onHome ? "active" : ""} to={user.role === "household" ? "/household" : "/collector"}>
            <IconHome size={20} color={onHome ? "var(--green)" : "var(--muted)"} />
            Home
          </Link>
          <Link className={onProfile ? "active" : ""} to="/profile">
            <IconPerson size={20} color={onProfile ? "var(--green)" : "var(--muted)"} />
            Profile
          </Link>
        </div>
      )}
    </div>
  );
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === "household") return <Navigate to="/household" replace />;
  if (user.role === "collector") return <Navigate to="/collector" replace />;
  return <Navigate to="/admin" replace />;
}

export default function App() {
  return (
    <>
      <UpdatePrompt />
      <Routes>
      <Route element={<Shell />}>
        <Route path="/login" element={<Login />} />
        <Route
          path="/household"
          element={
            <ProtectedRoute roles={["household"]}>
              <HouseholdHome />
            </ProtectedRoute>
          }
        />
        <Route
          path="/collector"
          element={
            <ProtectedRoute roles={["collector"]}>
              <CollectorHome />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute roles={["household", "collector"]}>
              <Profile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute roles={["admin"]}>
              <AdminDashboard />
            </ProtectedRoute>
          }
        />
      </Route>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
