import { useQuery } from '@tanstack/react-query'

/**
 * The running dia version (for example `0.42.0`, without a `v` prefix), or `undefined` until the
 * main process has answered. Fetched once per session and shared by every caller. Call it inside
 * the app's `QueryClientProvider`.
 */
export function useAppVersion(): string | undefined {
  return useQuery({
    queryKey: ['appVersion'],
    queryFn: () => window.dia.getAppVersion(),
    staleTime: Number.POSITIVE_INFINITY
  }).data
}
