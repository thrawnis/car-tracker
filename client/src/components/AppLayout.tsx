import { NavLink, Outlet } from "react-router-dom";
import { Car, LayoutDashboard, Settings, LogOut } from "lucide-react";
import { useAuth } from "@/api/auth";
import { useVault } from "@/api/vault";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/vehicles", label: "Vehicles", icon: Car, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

export function AppLayout() {
  const { logout } = useAuth();
  const { setDataKey } = useVault();

  async function onLogout() {
    await logout();
    setDataKey(null);
  }

  return (
    <div className="min-h-screen pb-16 sm:pb-0 sm:pl-56">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-slate-200 bg-white p-4 sm:flex">
        <div className="mb-6 flex items-center gap-2 px-2 text-lg font-semibold">
          <Car className="h-5 w-5 text-brand-600" /> Car Tracker
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium",
                  isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100",
                )
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={() => void onLogout()}
          className="flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          <LogOut className="h-4 w-4" /> Log out
        </button>
      </aside>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white sm:hidden">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium",
                isActive ? "text-brand-700" : "text-slate-500",
              )
            }
          >
            <Icon className="h-5 w-5" /> {label}
          </NavLink>
        ))}
      </nav>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
