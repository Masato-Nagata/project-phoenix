// Types of the Source_Bundler and of the Source_Bundle (design: packages/analyzer, "Source_Bundler (R1)" and
// "Source_Bundler decisions (OD-7, C5-1 to C5-7)"; tasks 2.1 and 2.4).
//
// - `manifest` is in allowlist order. `sha256Lf` is the lowercase hex SHA-256 of the UTF-8 bytes of the file text
//   after CRLF and lone CR were replaced by LF (R1.6).
// - `files[].text` is the LF-normalized text. A leading byte-order mark is kept as the character U+FEFF (R5.7).
import type { Result } from "../expr/types.js";

export interface SourceBundleManifestEntry {
  readonly path: string;
  readonly sha256Lf: string;
}

export interface SourceBundleFile {
  readonly path: string;
  readonly text: string;
}

export interface SourceBundle {
  readonly manifest: readonly SourceBundleManifestEntry[];
  readonly files: readonly SourceBundleFile[];
}

export type BundleErrorCode =
  | "allowlist_missing"
  | "allowlist_invalid_json"
  | "allowlist_no_files"
  | "allowlist_entry_not_string"
  | "entry_absolute"
  | "entry_traversal"
  | "entry_directory"
  | "entry_link"
  | "entry_duplicate"
  | "entry_missing"
  | "entry_unreadable"
  | "allowlist_md_mismatch"
  | "manifest_mismatch"
  | "allowlist_unknown_field"
  | "allowlist_unsupported_version"
  | "entry_not_utf8"
  // Added during task 2.1: the design lists no code for the entry-form rules of the reference builder (surrounding
  // whitespace, empty entry, backslash, wildcard character) and for the additional shape check. See the design note.
  | "entry_shape";

export interface BundleError {
  readonly code: BundleErrorCode;
  /** The offending entry or document path, when there is one. Never a host path. */
  readonly path?: string;
  readonly detail: string;
}

export type FileKind = "file" | "dir" | "symlink" | "other";

/**
 * The only I/O the Source_Bundler has. Both methods reject when the operation fails. A rejection whose `code` is
 * `ENOENT` means "does not exist"; any other rejection means "unreadable".
 */
export interface FileSystemPort {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<{ kind: FileKind; nlink: number }>;
}

export type BundleResult = Result<SourceBundle, BundleError>;