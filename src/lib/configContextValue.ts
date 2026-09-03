/**
 * The runtime-configuration context and its reader.
 *
 * Held apart from `ConfigContext.tsx` because that module exports a component: Vite's fast refresh
 * only replaces a module in place when every export is a component, so keeping the context object
 * and the hook here means editing the provider does not force a full reload.
 * @author John Grimes
 */

import { createContext, useContext } from "react";

import { FALLBACK_CONFIG, type AppConfig } from "./config";

/**
 * Carries the configuration fetched at startup.
 *
 * Defaults to `FALLBACK_CONFIG` so a component rendered outside the provider - in a unit test, say -
 * reads sane values rather than throwing.
 */
export const ConfigContext = createContext<AppConfig>(FALLBACK_CONFIG);

/**
 * Read the app's runtime configuration.
 * @returns The configuration supplied by the nearest `ConfigProvider`, or `FALLBACK_CONFIG` when
 *   there is no provider above this component.
 * @example
 * ```ts
 * const { fhirServerUrl } = useConfig();
 * ```
 */
export function useConfig(): AppConfig {
  return useContext(ConfigContext);
}
