import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { finishOAuthLogin, startOAuthLogin } from "@remote/shared/lib/oauth";

function getSafeNextPath(nextPath: string | undefined): string {
  if (!nextPath) {
    return "/";
  }

  if (
    !nextPath.startsWith("/") ||
    nextPath.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(nextPath)
  ) {
    return "/";
  }

  return nextPath;
}

export default function LoginCompletePage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/account_/complete" });
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const completion = useRef<{ key: string; promise: Promise<void> } | null>(
    null,
  );

  const handoffId = search.handoff_id;
  const appCode = search.app_code;
  const oauthError = search.error;
  const nextPath = getSafeNextPath(search.next);
  const reconnect = search.reconnect;

  useEffect(() => {
    let cancelled = false;
    const complete = async () => {
      if (oauthError) {
        setError(`OAuth error: ${oauthError}`);
        return;
      }

      if (!handoffId || !appCode) {
        setError("OAuth callback is incomplete. Please try again.");
        return;
      }

      try {
        const key = `${handoffId}:${appCode}:${reconnect ?? ""}`;
        if (completion.current?.key !== key) {
          completion.current = {
            key,
            promise: finishOAuthLogin(handoffId, appCode, reconnect),
          };
        }
        await completion.current.promise;
        if (!cancelled) window.location.replace(nextPath);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to complete login");
      }
    };

    void complete();
    return () => {
      cancelled = true;
    };
  }, [handoffId, appCode, oauthError, nextPath, reconnect]);

  const retry = async () => {
    setRetrying(true);
    try {
      if (reconnect) {
        await startOAuthLogin(reconnect, nextPath, true);
      } else {
        await navigate({
          to: "/account",
          search: nextPath !== "/" ? { next: nextPath } : undefined,
          replace: true,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restart OAuth");
    } finally {
      setRetrying(false);
    }
  };

  if (error) {
    return (
      <StatusCard title="Login failed" variant="error">
        <p className="text-sm text-normal mt-base">{error}</p>
        <button
          type="button"
          className="mt-double w-full rounded-sm bg-brand px-base py-half text-sm font-medium text-on-brand transition-colors hover:bg-brand-hover"
          disabled={retrying}
          onClick={() => void retry()}
        >
          Try again
        </button>
      </StatusCard>
    );
  }

  return (
    <StatusCard title="Completing login...">
      <p className="text-sm text-low mt-base">Processing OAuth callback...</p>
    </StatusCard>
  );
}

function StatusCard({
  title,
  variant,
  children,
}: {
  title: string;
  variant?: "error";
  children: React.ReactNode;
}) {
  return (
    <div className="h-dvh overflow-auto bg-primary">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-base py-double">
        <div className="rounded-sm border border-border bg-secondary p-double">
          <h2
            className={`text-lg font-semibold ${variant === "error" ? "text-error" : "text-high"}`}
          >
            {title}
          </h2>
          {children}
        </div>
      </div>
    </div>
  );
}
