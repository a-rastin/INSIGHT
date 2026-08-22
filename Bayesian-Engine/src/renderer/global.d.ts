import type { BayesEngineApi } from "../preload/api";

declare global {
  interface Window {
    bayesEngine: BayesEngineApi;
  }
}

export {};
