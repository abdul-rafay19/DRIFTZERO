"use client";

import { useEffect, useState } from "react";
import type { HealthResponse, ApiResponse } from "@driftzero/shared";
import styles from "./page.module.css";

type ConnectionState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "healthy"; data: HealthResponse };

export default function HomePage() {
  const [connection, setConnection] = useState<ConnectionState>({ phase: "loading" });

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    if (!apiUrl) {
      setConnection({ phase: "error", message: "NEXT_PUBLIC_API_URL is not configured." });
      return;
    }

    fetch(`${apiUrl}/api/health`)
      .then((res) => res.json() as Promise<ApiResponse<HealthResponse>>)
      .then((body) => {
        if (body.success && body.data) {
          setConnection({ phase: "healthy", data: body.data });
        } else {
          setConnection({ phase: "error", message: body.error ?? "Unknown error from backend." });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Failed to reach backend.";
        setConnection({ phase: "error", message });
      });
  }, []);

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>DriftZero</h1>
      <p className={styles.subtitle}>AI-Powered Migration Engine</p>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Backend Connection</h2>

        {connection.phase === "loading" && (
          <p className={styles.loading}>Connecting to backend…</p>
        )}

        {connection.phase === "error" && (
          <p className={styles.error}>Error: {connection.message}</p>
        )}

        {connection.phase === "healthy" && (
          <dl className={styles.healthGrid}>
            <dt>Status</dt>
            <dd className={styles.statusOk}>{connection.data.status}</dd>

            <dt>Version</dt>
            <dd>{connection.data.version}</dd>

            <dt>Uptime</dt>
            <dd>{connection.data.uptime.toFixed(2)}s</dd>

            <dt>Timestamp</dt>
            <dd>{connection.data.timestamp}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
