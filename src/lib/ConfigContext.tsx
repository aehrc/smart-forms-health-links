import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { FALLBACK_CONFIG, loadConfig, type AppConfig } from './config';

const ConfigContext = createContext<AppConfig>(FALLBACK_CONFIG);

export function useConfig(): AppConfig {
  return useContext(ConfigContext);
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadConfig().then((loaded) => {
      if (!cancelled) {
        setConfig(loaded);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (config === null) {
    return null;
  }

  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}
