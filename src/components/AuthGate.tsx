import { useState, type ReactNode } from "react";
import { isSignedIn } from "@/engine/auth";
import { LoginPage } from "./LoginPage";

/** The dashboard (and its DuckDB / dataset work) is not even mounted until the user has authenticated. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(isSignedIn());
  return ok ? <>{children}</> : <LoginPage onAuthed={() => setOk(true)} />;
}
