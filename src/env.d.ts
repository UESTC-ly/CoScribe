/// <reference types="vite/client" />

import type { CoScribeAPI } from './shared/types'

declare global {
  interface Window {
    coscribe: CoScribeAPI
  }
}

export {}
