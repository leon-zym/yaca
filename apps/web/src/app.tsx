import { BootstrapResponseSchema, Value, type BootstrapResponse } from "@yaca/contracts";
import { CircleCheck, RotateCcw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "./components/ui/button.js";

type BootstrapState =
  | { status: "loading" }
  | { status: "ready"; bootstrap: BootstrapResponse }
  | { status: "error"; message: string };

async function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  const response = await fetch("/api/bootstrap", {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Host returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!Value.Check(BootstrapResponseSchema, value)) {
    throw new Error("Host bootstrap did not match the supported schema");
  }
  return value;
}

export function App() {
  const [state, setState] = useState<BootstrapState>({ status: "loading" });

  const loadBootstrap = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", bootstrap: await fetchBootstrap() });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchBootstrap(controller.signal)
      .then((bootstrap) => setState({ status: "ready", bootstrap }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border bg-surface/80 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <div className="flex items-baseline gap-3">
            <span className="text-base font-semibold tracking-tight">yaca</span>
            <span className="text-muted-foreground text-xs">foundation</span>
          </div>
          <span className="text-muted-foreground font-mono text-xs">
            {state.status === "ready" ? `v${state.bootstrap.version}` : "local Host"}
          </span>
        </div>
      </header>

      <main className="mx-auto grid min-h-[calc(100vh-3.5rem)] max-w-5xl place-items-center px-6 py-16">
        <section className="w-full max-w-xl" aria-live="polite">
          {state.status === "loading" ? (
            <div className="text-muted-foreground flex items-center gap-3 text-sm">
              <Server className="size-4" aria-hidden="true" />
              Connecting to the local Host…
            </div>
          ) : null}

          {state.status === "ready" ? (
            <div className="space-y-8">
              <div className="space-y-3">
                <div className="text-primary flex items-center gap-2 text-sm font-medium">
                  <CircleCheck className="size-4" aria-hidden="true" />
                  Local Host ready
                </div>
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                  The yaca foundation is running.
                </h1>
                <p className="text-muted-foreground max-w-lg text-base leading-7">
                  This build serves the Web shell and verifies the loopback Host boundary.
                  Workspace, Session, and agent controls are intentionally not included in this
                  foundation slice.
                </p>
              </div>

              <dl className="border-border bg-border grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2">
                <div className="bg-surface px-4 py-3">
                  <dt className="text-muted-foreground text-xs">Origin</dt>
                  <dd className="mt-1 text-sm font-medium">Loopback only</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="text-muted-foreground text-xs">Protocol foundation</dt>
                  <dd className="mt-1 font-mono text-sm">
                    {state.bootstrap.protocol.major}.{state.bootstrap.protocol.minor}
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}

          {state.status === "error" ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="text-destructive text-sm font-medium">Local Host unavailable</p>
                <h1 className="text-3xl font-semibold tracking-tight">
                  The Web shell could not connect.
                </h1>
                <p className="text-muted-foreground text-sm leading-6">{state.message}</p>
              </div>
              <Button onClick={() => void loadBootstrap()}>
                <RotateCcw className="size-4" aria-hidden="true" />
                Retry connection
              </Button>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
