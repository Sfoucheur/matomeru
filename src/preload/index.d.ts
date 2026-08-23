import type { MatomeruApi } from './index'

declare global {
  interface Window {
    api: MatomeruApi
  }
}

export {}
