/**
 * `localStorage` access that never throws: storage can be missing (SSR, workers), disabled (privacy
 * modes, sandboxed iframes, which throw on property access) or full. Every failure degrades to
 * "nothing stored" rather than breaking the SDK call that touched storage.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function browserLocalStorage(): KeyValueStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (!storage) return undefined;
    const probe = "gamebeast:probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

export class SafeStorage {
  private readonly backend: KeyValueStorage;

  /** `null` keeps everything in memory; omitted uses `localStorage` where it works. */
  constructor(backend?: KeyValueStorage | null) {
    const resolved = backend === null ? undefined : (backend ?? browserLocalStorage());
    this.backend = resolved ?? new MemoryStorage();
  }

  getJson<T>(key: string): T | undefined {
    try {
      const raw = this.backend.getItem(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  }

  setJson(key: string, value: unknown): boolean {
    try {
      this.backend.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  getString(key: string): string | undefined {
    try {
      return this.backend.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  }

  setString(key: string, value: string): boolean {
    try {
      this.backend.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  remove(key: string): void {
    try {
      this.backend.removeItem(key);
    } catch {
      // Ignore: storage is best-effort.
    }
  }
}

/**
 * Short, stable fingerprint of the API key (FNV-1a). Namespaces cached data so two Gamebeast
 * projects on the same origin cannot read each other's caches; it is not a secret.
 */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
