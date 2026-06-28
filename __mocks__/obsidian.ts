// Minimal runtime mock for Obsidian API — used by vitest only.
// The real obsidian package ships type definitions only (no runtime).

export function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

// Stub classes needed for instanceof checks in storage.ts.
// Obsidian's real TFile/TFolder extend TAbstractFile — we only need the shape.
export class TAbstractFile {
  path!: string;
  name!: string;
  parent!: any;
  vault!: any;
}

export class TFile extends TAbstractFile {
  basename!: string;
  extension!: string;
  stat!: { ctime: number; mtime: number; size: number };
}

export class TFolder extends TAbstractFile {
  children!: TAbstractFile[];
  isRoot(): boolean { return false; }
}

export class Notice {
  constructor(public message: string) {}
}

export class Vault {
  adapter: any;
  constructor() {
    this.adapter = null;
  }

  // Stub the Vault-level API methods used by AnnotationStore.
  // Tests provide their own mock vault object, so these default stubs are
  // fallbacks for type compatibility only.
  getAbstractFileByPath(_path: string): TAbstractFile | null { return null; }
  async read(_file: TFile): Promise<string> { throw new Error("not mocked"); }
  async create(_path: string, _data: string): Promise<TFile> { throw new Error("not mocked"); }
  async createFolder(_path: string): Promise<void> {}
  async process(_file: TFile, _fn: (data: string) => string): Promise<string> {
    throw new Error("not mocked");
  }
  async trash(_file: TFile, _system?: boolean): Promise<void> { throw new Error("not mocked"); }
  async delete(_file: TFile, _force?: boolean): Promise<void> { throw new Error("not mocked"); }
}
