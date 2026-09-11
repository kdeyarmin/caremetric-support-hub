import { useEffect, useState } from "react";
import { readAdminResource } from "./readState";
import type { AdminReadState } from "./readState";

export function useAdminRead<T>(reader: (signal: AbortSignal) => Promise<T>): AdminReadState<T> {
  const [entry, setEntry] = useState<{ reader: typeof reader; state: AdminReadState<T> }>(() => ({ reader, state: { status: "loading" } }));
  useEffect(() => {
    const controller = new AbortController();
    void readAdminResource(reader, controller.signal, state => setEntry({ reader, state }));
    return () => controller.abort();
  }, [reader]);
  return entry.reader === reader ? entry.state : { status: "loading" };
}
