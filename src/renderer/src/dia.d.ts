import type { DiaApi } from '@shared/ipc/contract'

declare global {
  interface Window {
    dia: DiaApi
  }
}
