import { useCallback, useEffect, useState } from "react";
import { api, loadSession, saveSession, setToken, setUnauthorizedHandler, type Session } from "./api.ts";
import { Inbox } from "./Inbox.tsx";
import { Login } from "./Login.tsx";
import { Manage } from "./Manage.tsx";
import { bipe } from "./matrix.ts";
import { BipeStatus } from "./ui.tsx";

type View = "inbox" | "manage";

export function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const s = loadSession();
    setToken(s?.token ?? null);
    return s;
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>("inbox");

  const end = useCallback((message: string | null) => {
    setToken(null);
    saveSession(null);
    void bipe.clear();
    setSession(null);
    setView("inbox");
    setNotice(message);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => end("Sua sessão terminou. Entre de novo."));
  }, [end]);

  useEffect(() => {
    if (session) void bipe.start(session.matrix);
  }, [session]);

  const signedIn = (s: Session) => {
    setToken(s.token);
    saveSession(s);
    setNotice(null);
    setSession(s);
  };

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // The session may already be gone on the server. Clear this side anyway.
    }
    end(null);
  };

  if (!session) return <Login onSignedIn={signedIn} notice={notice} />;
  const manager = session.agent.role === "manager";

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="wordmark">Bipe</span>
          <span className="company">@{session.company.handle}</span>
        </div>
        <nav aria-label="Seções">
          <button type="button" className="tab" aria-current={view === "inbox" ? "page" : undefined} onClick={() => setView("inbox")}>
            Conversas
          </button>
          {manager && (
            <button type="button" className="tab" aria-current={view === "manage" ? "page" : undefined} onClick={() => setView("manage")}>
              Gestão
            </button>
          )}
        </nav>
        <BipeStatus />
        <div className="me">
          <span className="me-name">{session.agent.name}</span>
          <button type="button" className="ghost" onClick={signOut}>
            Sair
          </button>
        </div>
      </header>
      {view === "manage" && manager ? <Manage session={session} /> : <Inbox session={session} />}
    </div>
  );
}
