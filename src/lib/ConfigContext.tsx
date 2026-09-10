import { useEffect, useState, type ReactNode } from "react";

import { loadConfig, type AppConfig } from "./config";
import { ConfigContext } from "./configContextValue";

/**
 *
 * @param root0
 * @param root0.children
 */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadConfig().then((loaded) => {
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

  return (
    <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
  );
}
