"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);

    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password })
    });

    const payload = await response.json();
    if (!response.ok) {
      setSubmitting(false);
      setErrorMessage(payload.error || "Login failed.");
      return;
    }

    router.push("/admin");
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <p className="muted">Private dashboard for the compliment operator.</p>
      <div className="field-row">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          className="retro-input"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
      </div>
      {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
      <button type="submit" className="retro-button" disabled={submitting}>
        {submitting ? "Logging in..." : "Open dashboard"}
      </button>
    </form>
  );
}
