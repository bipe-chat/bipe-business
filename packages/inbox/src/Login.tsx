import { useState, type FormEvent } from "react";
import { api, ApiError, type Session } from "./api.ts";

function loginError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "wrong_credentials" || e.code === "invalid") return "E-mail ou senha não conferem.";
    if (e.code === "rate_limited") return "Muitas tentativas. Espere alguns minutos e tente de novo.";
    if (e.code === "bipe_unavailable") return "O Bipe não respondeu. Tente de novo em alguns minutos.";
    if (e.code === "network") return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  }
  return "Algo deu errado. Tente de novo.";
}

export function Login({ onSignedIn, notice }: { onSignedIn: (s: Session) => void; notice: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(email.trim(), password));
    } catch (err) {
      setError(loginError(err));
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit} aria-describedby={error ? "login-error" : undefined}>
        <p className="wordmark big">Bipe</p>
        <h1>Atendimento</h1>
        <p className="muted">Conversas do Bipe e do WhatsApp num lugar só.</p>
        {notice && <p className="notice">{notice}</p>}
        <label>
          E-mail
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Senha
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p id="login-error" className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <p className="muted small">Este navegador entra como um aparelho da conta da empresa no Bipe. Quando você sai, o aparelho sai junto.</p>
      </form>
    </main>
  );
}
