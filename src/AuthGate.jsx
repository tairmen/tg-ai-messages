import React, { useState, useEffect } from "react";
import { Button, TextInput, PasswordInput, Alert, Loader } from "@mantine/core";
import { IconSend, IconArrowRight, IconLock } from "@tabler/icons-react";
function continueToAuthorization() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (
    window.location.pathname === "/login" &&
    next?.startsWith("/authorize?")
  ) {
    window.location.replace(next);
    return true;
  }
  return false;
}
export default function AuthGate({ children }) {
  const [session, setSession] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated && !continueToAuthorization()) setSession(data);
        else if (!data.authenticated) setSession(data);
      })
      .catch(() =>
        setError("Cannot reach your workspace. Please refresh to retry."),
      );
    const expired = () => setSession({ authenticated: false });
    window.addEventListener("relay-auth-expired", expired);
    return () => window.removeEventListener("relay-auth-expired", expired);
  }, []);
  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    setSession({ authenticated: false });
  }
  if (!session)
    return (
      <div className="login-loading">
        {error ? (
          <Alert color="red">{error}</Alert>
        ) : (
          <>
            <Loader color="teal" />
            <p>Opening your workspace…</p>
          </>
        )}
      </div>
    );
  if (session.authenticated) return children(logout);
  return (
    <Login
      onSuccess={(data) => {
        if (!continueToAuthorization()) setSession(data);
      }}
    />
  );
}
function Login({ onSuccess }) {
  const [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Sign in failed.");
      setPassword("");
      onSuccess(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-shell">
      <section className="login-story">
        <a className="brand" href="/">
          <span className="brand-icon">
            <IconSend size={24} />
          </span>
          relay<span className="brand-dot">.</span>
        </a>
        <div className="login-story-copy">
          <div className="eyebrow">MAKE EVERY CONVERSATION COUNT</div>
          <h1>
            A closer connection.
            <br />A calmer workday.
          </h1>
          <p>
            Your customer messages, campaigns, and AI assistant. Together in one
            thoughtful workspace.
          </p>
          <div className="login-orbits">
            <span />
            <span />
            <span />
            <div>
              <IconSend size={45} />
            </div>
          </div>
        </div>
        <small>Built for personal conversations.</small>
      </section>
      <section className="login-form-side">
        <form className="login-form" onSubmit={submit}>
          <span className="login-lock">
            <IconLock size={22} />
          </span>
          <h1>Welcome back.</h1>
          <p>Sign in to your Telegram workspace.</p>
          {error && (
            <Alert color="red" mb="lg" role="alert">
              {error}
            </Alert>
          )}
          <TextInput
            label="Username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            size="md"
          />
          <PasswordInput
            mt="lg"
            label="Password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            size="md"
          />
          <Button
            fullWidth
            size="md"
            mt="xl"
            type="submit"
            loading={busy}
            rightSection={<IconArrowRight size={18} />}
          >
            Sign in
          </Button>
          <div className="login-note">
            <IconLock size={13} />
            <span>Your workspace is protected with a secure session.</span>
          </div>
        </form>
        <small className="login-copyright">
          relay · Your conversations, thoughtfully managed.
        </small>
      </section>
    </div>
  );
}
