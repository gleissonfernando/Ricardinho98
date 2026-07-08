import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import type { ReactNode } from "react";
import { Login } from "./pages/Login";
import { useAuth } from "./hooks/useAuth";
import { dashboardSlugFromPath, dashboardUrl, isDashboardRoutePath } from "./lib/urls";

const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const DevDashboard = lazy(() => import("./pages/DevDashboard").then((module) => ({ default: module.DevDashboard })));
const GiveawayRoulettePage = lazy(() => import("./pages/GiveawayRoulette").then((module) => ({ default: module.GiveawayRoulettePage })));
const OrvitechProductPage = lazy(() => import("./pages/OrvitechProductPage").then((module) => ({ default: module.OrvitechProductPage })));

export function App() {
  const {
    accessValidation,
    auth,
    checkingAccess,
    error,
    loading,
    loginDiscord,
    logout,
    refresh,
    status,
    verify,
    verifying
  } = useAuth();
  const path = window.location.pathname;
  const rouletteToken = rouletteTokenFromPath(path);
  const productRoute = orvitechProductRouteFromPath(path);
  const routeError = readAuthError();
  const dashboardPath = isDashboardRoutePath(path);
  const devPanelPath = path === "/dev" || path.startsWith("/dev/");
  const protectedPanelPath = dashboardPath || devPanelPath;

  useEffect(() => {
    if (rouletteToken || productRoute) {
      return;
    }

    if (auth?.access.verified && !protectedPanelPath) {
      window.location.replace(dashboardUrl());
    }
  }, [auth, productRoute, protectedPanelPath, rouletteToken]);

  useEffect(() => {
    if (rouletteToken || productRoute) {
      return;
    }

    if (loading || !protectedPanelPath || error || routeError || auth) {
      return;
    }

    loginDiscord();
  }, [auth, protectedPanelPath, error, loading, loginDiscord, productRoute, routeError, rouletteToken]);

  if (rouletteToken) {
    return <LazyRoute><GiveawayRoulettePage token={rouletteToken} /></LazyRoute>;
  }

  if (productRoute) {
    return <LazyRoute><OrvitechProductPage slug={productRoute.slug} storeId={productRoute.storeId} /></LazyRoute>;
  }

  if (loading) {
    return <LoadingScreen />;
  }

  if (!auth || !auth.access.verified) {
    return (
      <Login
        accessValidation={accessValidation}
        auth={auth}
        checkingAccess={checkingAccess}
        error={routeError ?? error}
        onLoginDiscord={loginDiscord}
        onLogout={logout}
        onRetry={refresh}
        onVerify={verify}
        status={routeError ? "Acesso negado." : status}
        verifying={verifying}
      />
    );
  }

  if (devPanelPath) {
    return <LazyRoute><DevDashboard auth={auth} initialView={devViewFromPath(path)} onLogout={logout} /></LazyRoute>;
  }

  return <LazyRoute><Dashboard auth={auth} initialBotSlug={dashboardSlugFromPath(path)} onLogout={logout} /></LazyRoute>;
}

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingScreen />}>{children}</Suspense>;
}

function readAuthError() {
  const reason = new URLSearchParams(window.location.search).get("reason");
  const authError = new URLSearchParams(window.location.search).get("authError");

  if (!reason && !authError) {
    return null;
  }

  if (authError === "denied") {
    return "Voce nao esta liberado para acessar esta dashboard.";
  }

  if (reason === "permission") {
    return "Sua conta foi autenticada, mas nao possui permissao suficiente para acesso administrativo.";
  }

  if (reason === "callback") {
    return "A resposta do Discord expirou ou nao corresponde a sua sessao. Tente autenticar novamente.";
  }

  if (reason === "denied") {
    return "Você não está liberado para acessar esta dashboard.";
  }

  return "Nao foi possivel concluir a autenticacao Discord. Tente novamente.";
}

function rouletteTokenFromPath(path: string) {
  if (!path.startsWith("/roulette/")) {
    return null;
  }

  const token = path.slice("/roulette/".length).split("/")[0]?.trim();

  if (!token) {
    return null;
  }

  try {
    return decodeURIComponent(token);
  } catch {
    return null;
  }
}

function orvitechProductRouteFromPath(path: string) {
  if (!path.startsWith("/orvitech/")) {
    return null;
  }

  const [, , storeId, slug] = path.split("/");

  if (!storeId || !slug) {
    return null;
  }

  return {
    slug,
    storeId
  };
}

function devViewFromPath(path: string): "bots" | "connected" | "bot-menu" | "cloning" | "sales" | "hosting-backup" | "fivem" | "police" | "logs" | "access" | "maintenance" {
  if (path.startsWith("/dev/bots-conectados")) {
    return "connected";
  }

  if (path.startsWith("/dev/menu-do-bot")) {
    return "bot-menu";
  }

  if (path.startsWith("/dev/clonagem")) {
    return "cloning";
  }

  if (path.startsWith("/dev/vendas-orvitech")) {
    return "sales";
  }

  if (path.startsWith("/dev/backup-de-hospedagem")) {
    return "hosting-backup";
  }

  if (path.startsWith("/dev/fivem")) {
    return "fivem";
  }

  if (path.startsWith("/dev/policia")) {
    return "police";
  }

  if (path.startsWith("/dev/logs")) {
    return "logs";
  }

  if (path.startsWith("/dev/acessos")) {
    return "access";
  }

  if (path.startsWith("/dev/maintenance")) {
    return "maintenance";
  }

  return "bots";
}

function LoadingScreen() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#050505] px-4">
      <div className="absolute inset-0 bg-[#050505]" />
      <div className="relative flex animate-in fade-in slide-in-from-bottom-3 flex-col items-center rounded-lg border border-white/10 bg-white/[0.07] px-8 py-7 text-center shadow-glow backdrop-blur-2xl">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-200" />
        <p className="mt-4 text-sm font-medium text-white">Carregando painel</p>
        <p className="mt-1 text-xs text-zinc-500">Sincronizando sessao Discord</p>
      </div>
    </main>
  );
}
