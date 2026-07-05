import type { AgrflowApi } from "../main/preload";

declare global {
  interface Window {
    agrflow: AgrflowApi;
  }
}

export {};
