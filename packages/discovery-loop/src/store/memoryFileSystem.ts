// In-memory FileSystemPort for tests. Directories must exist before files are created in them.
import type { FileSystemPort } from "./fileSystemPort.js";

export class MemoryFileSystem implements FileSystemPort {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(["/"]);

  /** Test helper: creates a directory and its parents. */
  addDir(path: string): void {
    const parts = path.split("/").filter((p) => p !== "");
    let cur = "";
    for (const p of parts) {
      cur += `/${p}`;
      this.dirs.add(cur);
    }
  }

  /** Test helper: current bytes of a file (a copy), or undefined. */
  peek(path: string): Uint8Array | undefined {
    const f = this.files.get(path);
    return f === undefined ? undefined : new Uint8Array(f);
  }

  /** Test helper: every file path, sorted. */
  allFiles(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Test helper: puts a file in place without any checks. */
  poke(path: string, data: Uint8Array): void {
    this.files.set(path, new Uint8Array(data));
  }

  private parent(path: string): string {
    const i = path.lastIndexOf("/");
    return i <= 0 ? "/" : path.slice(0, i);
  }

  async listDir(path: string): Promise<string[] | undefined> {
    if (!this.dirs.has(path)) return undefined;
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p !== path && p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0] as string);
    }
    return [...names].sort();
  }

  async mkdir(path: string): Promise<void> {
    if (!this.dirs.has(this.parent(path))) throw new Error(`ENOENT: parent of ${path}`);
    this.dirs.add(path);
  }

  async writeFileSynced(path: string, data: Uint8Array): Promise<void> {
    if (!this.dirs.has(this.parent(path))) throw new Error(`ENOENT: parent of ${path}`);
    this.files.set(path, new Uint8Array(data));
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (f === undefined) throw new Error(`ENOENT: ${from}`);
    if (!this.dirs.has(this.parent(to))) throw new Error(`ENOENT: parent of ${to}`);
    this.files.delete(from);
    this.files.set(to, f);
  }

  async syncDir(_path: string): Promise<void> {}

  async readFile(path: string): Promise<Uint8Array | undefined> {
    const f = this.files.get(path);
    return f === undefined ? undefined : new Uint8Array(f);
  }

  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
  }
}
