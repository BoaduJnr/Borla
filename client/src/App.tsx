import { Navigate, Route, Routes, Link, useLocation } from "react-router-dom";
import { useAuth } from "./hooks/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Logo } from "./components/Logo";
import { IconHome, IconPerson } from "./components/Icon";
import Login from "./pages/Login";
import HouseholdHome from "./pages/HouseholdHome";
import CollectorHome from "./pages/CollectorHome";
import AdminDashboard from "./pages/AdminDashboard";
import Profile from "./pages/Profile";

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const onHome = loc.pathname.startsWith("/household") || loc.pathname.startsWith("/collector");
  const onProfile = loc.pathname === "/profile";
  return (
    <div className={`app-shell ${wide ? "wide" : ""}`}>
      <div className="topbar">
        <Logo size={28} />
        <span className="spacer" />
        {user && (
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Log out
          </button>
        )}
      </div>
      {children}
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
    <Routes>
      <Route
        path="/login"
        element={
          <Shell>
            <Login />
          </Shell>
        }
      />
      <Route
        path="/household"
        element={
          <Shell>
            <ProtectedRoute roles={["household"]}>
              <HouseholdHome />
            </ProtectedRoute>
          </Shell>
        }
      />
      <Route
        path="/collector"
        element={
          <Shell>
            <ProtectedRoute roles={["collector"]}>
              <CollectorHome />
            </ProtectedRoute>
          </Shell>
        }
      />
      <Route
        path="/profile"
        element={
          <Shell>
            <ProtectedRoute roles={["household", "collector"]}>
              <Profile />
            </ProtectedRoute>
          </Shell>
        }
      />
      <Route
        path="/admin"
        element={
          <Shell wide>
            <ProtectedRoute roles={["admin"]}>
              <AdminDashboard />
            </ProtectedRoute>
          </Shell>
        }
      />
      <Route path="/" element={<HomeRedirect />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
