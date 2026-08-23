import { useContext } from 'react';

import { ConfigContext } from './ConfigContext';
import type { AppConfig } from './config';

/**
 * Hook to access the current application configuration.
 * @returns The current application configuration.
 * @throws Error if used outside of a ConfigProvider.
 * @author John Grimes
 */
export function useConfig(): AppConfig {
  return useContext(ConfigContext);
}
