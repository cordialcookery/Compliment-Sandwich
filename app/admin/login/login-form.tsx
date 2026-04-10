"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

async function readResponsePayload(response: Response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as { error?: string };
    return payload.error || "Login failed.";
  }

  const text = (await response.text()).trim();
  return text || "Login failed.";
}

export function LoginForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);

    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password })
      });

      if (!response.ok) {
        setErrorMessage(await readResponsePayload(response));
        return;
      }

      router.push("/admin");
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <p className="muted">Private dashboard for the compliment operator.</p>
      <div className="field-row">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          className="retro-input"
          autoComplete="current-password"
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
