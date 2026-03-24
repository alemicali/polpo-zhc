import { useState, useCallback, useRef } from "react";

export interface MutationState<T = unknown> {
  isPending: boolean;
  error: Error | null;
  data: T | null;
}

export function useMutation<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  opts?: { onSuccess?: (data: TResult) => void | Promise<void> },
): {
  mutate: (...args: TArgs) => Promise<TResult>;
  isPending: boolean;
  error: Error | null;
} {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const mutate = useCallback(async (...args: TArgs): Promise<TResult> => {
    setIsPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      await optsRef.current?.onSuccess?.(result);
      return result;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setIsPending(false);
    }
  }, []);

  return { mutate, isPending, error };
}
