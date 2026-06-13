declare const __YACA_VERSION__: string;

export const YACA_VERSION =
  typeof __YACA_VERSION__ === "undefined" ? "0.0.0-dev" : __YACA_VERSION__;
