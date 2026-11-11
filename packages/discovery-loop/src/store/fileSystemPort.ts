// File-system port of the Evidence_Store write path (design: "Atomic write"). Paths are plain strings joined with "/".
// Real adapter: nodeFileSystem.ts. Test adapter: memoryFileSystem.ts.
export interface FileSystemPort {
  /** Names (not paths) in a directory, or `undefined` when the path is not an existing directory (missing, or a file). */
  listDir(path: string): Promise<string[] | undefined>;
  /** Creates one directory level. Succeeds when it already exists as a directory. */
  mkdir(path: string): Promise<void>;
  /** Creates or truncates the file, writes all bytes and flushes them to stable storage before returning. */
  writeFileSynced(path: string, data: Uint8Array): Promise<void>;
  /** Atomic replace on the same file system. */
  rename(from: string, to: string): Promise<void>;
  /** Flushes directory metadata where the platform supports it; otherwise does nothing. */
  syncDir(path: string): Promise<void>;
  /** File content, or `undefined` when the file does not exist. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Removes a file; missing file is not an error. Used only to clean up the store's own temporary files. */
  removeFile(path: string): Promise<void>;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
