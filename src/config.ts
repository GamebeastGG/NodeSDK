export interface GamebeastOptions {
  apiKey: string;
  markerFlushSize?: number;
  globalIdentifier?: string;
  url?: string;
  production?: boolean;
}

const DEFAULT_CONFIG = {
  markerFlushSize: 100,
  url : "https://api.gamebeast.gg",
  production: false,
  globalIdentifier: null
};

let config: GamebeastOptions | null = null;

export function setConfig(options: GamebeastOptions): void {

  const newConfig = options as Record<string, any>;

  for (const key in DEFAULT_CONFIG) {
    if (!(key in options)) {
      newConfig[key] = DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG];
    }
  }
  
  config = newConfig as GamebeastOptions;
}

export function getSdkConfig(): GamebeastOptions {
  if (!config) {
    throw new Error(
      "Gamebeast is not initialized. Call Gamebeast.setup() before using any services."
    );
  }
  return config;
}
