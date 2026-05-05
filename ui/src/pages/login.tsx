import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { config } from "@/lib/config";

async function authApi(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${config.baseUrl}/api/v1/auth/instance${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  return res.json();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const requestedNext = params.get("next");
  const next = requestedNext?.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/chat";
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authApi("/status")
      .then((r) => {
        if (r.ok && (!r.data.enabled || r.data.authenticated)) {
          navigate(next, { replace: true });
        }
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [navigate, next]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isValidEmail(email)) return;
    setSending(true);
    setError(null);
    try {
      const result = await authApi("/magic-link", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      if (result.ok) {
        setSent(true);
      } else {
        setError(result.error || "Could not send the login link.");
      }
    } catch {
      setError("Could not connect to server.");
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md border-border/60 shadow-lg shadow-black/[0.03]">
        <CardContent className="pt-6 pb-6 px-6 space-y-6">
          <div className="text-center space-y-2">
            <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to Polpo</h1>
            <p className="text-sm text-muted-foreground">
              Enter the admin email for this instance.
            </p>
          </div>

          {sent ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                If this email is allowed, a login link has been sent.
              </p>
              <Button variant="outline" onClick={() => setSent(false)} className="w-full">
                Use another email
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Email
                </label>
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  autoFocus
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" disabled={sending || !isValidEmail(email)} className="w-full gap-1.5">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Send magic link <ArrowRight className="h-4 w-4" /></>}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
