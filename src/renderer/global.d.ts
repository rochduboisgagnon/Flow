import type { AgrflowApi, FlowUiApi } from "../main/preload";

declare global {
  interface Window {
    agrflow: AgrflowApi;
    flowui: FlowUiApi;
  }
}

export {};
