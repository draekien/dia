import type { DiaApi } from '@main/ipc/contract'

declare global {
  interface Window {
    dia: DiaApi
  }
}
