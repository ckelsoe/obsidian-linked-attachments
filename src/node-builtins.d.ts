// Ambient declarations for the Node built-ins this desktop-only plugin uses.
// The Obsidian marketplace source-scan installs no dependencies (not even
// @types/node) and honors this tsconfig, so without these it sees
// fs/os/path/process as `any` and fires @typescript-eslint/no-unsafe-*. These
// cover the full surface used by both src and tests, so they stand in cleanly
// under the scan and coexist with @types/node locally. Kept minimal on purpose;
// add a member here when the plugin starts using a new Node API.
// Only the `process` members this plugin reads, exposed as a module so callers
// import { platform, env } from 'node:process' rather than touching a global
// (a global declaration would need the no-var eslint idiom). Merges with
// @types/node locally and stands alone under the scan.
declare module 'node:process' {
  export const platform: 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';
  export const env: { [key: string]: string | undefined };
}

declare module 'os' {
  export function hostname(): string;
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'path' {
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(p: string): boolean;
  export const sep: string;
}

declare module 'fs' {
  export interface Stats {
    size: number;
    mtimeMs: number;
    blocks: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    write(data: Uint8Array): Promise<{ bytesWritten: number }>;
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export namespace promises {
    function mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
    function mkdtemp(prefix: string): Promise<string>;
    function stat(path: string): Promise<Stats>;
    function lstat(path: string): Promise<Stats>;
    function access(path: string): Promise<void>;
    function unlink(path: string): Promise<void>;
    function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
    function rmdir(path: string): Promise<void>;
    function rename(from: string, to: string): Promise<void>;
    function readFile(path: string): Promise<Uint8Array>;
    function writeFile(path: string, data: string | Uint8Array): Promise<void>;
    function readdir(path: string): Promise<string[]>;
    function readdir(path: string, opts: { withFileTypes: true }): Promise<Dirent[]>;
    function open(path: string, flags?: string): Promise<FileHandle>;
  }
}
