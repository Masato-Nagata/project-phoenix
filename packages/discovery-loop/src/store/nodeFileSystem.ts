// Real Node.js adapter of FileSystemPort. The runtime uses it on the Linux-side Run_Volume (A9).
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { FileSystemPort } from "./fileSystemPort.js";

const code = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

export function createNodeFileSystem(): FileSystemPort {
  return {
    async listDir(path) {
      try {
        return await readdir(path);
      } catch (e) {
        // A path that is a file (ENOTDIR) is not a directory either; verification walks trees with this.
        if (code(e) === "ENOENT" || code(e) === "ENOTDIR") return undefined;
        throw e;
      }
    },
    async mkdir(path) {
      try {
        await mkdir(path);
      } catch (e) {
        if (code(e) === "EEXIST" && (await stat(path)).isDirectory()) return;
        throw e;
      }
    },
    async writeFileSynced(path, data) {
      const handle = await open(path, "w");
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async syncDir(path) {
      let handle;
      try {
        handle = await open(path, "r");
        await handle.sync();
      } catch (e) {
        // Directory fsync is not supported everywhere (for example on Windows); that is not a write failure.
        const c = code(e);
        if (c === "EISDIR" || c === "EPERM" || c === "EINVAL" || c === "ENOTSUP" || c === "EACCES") return;
        throw e;
      } finally {
        await handle?.close();
      }
    },
    async readFile(path) {
      try {
        return new Uint8Array(await readFile(path));
      } catch (e) {
        if (code(e) === "ENOENT") return undefined;
        throw e;
      }
    },
    async removeFile(path) {
      await rm(path, { force: true });
    },
  };
}
