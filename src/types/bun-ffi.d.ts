// Shim for bun:ffi types — OpenTUI's .d.ts files import from "bun:ffi"
// but we run type-checking with tsc which doesn't know Bun builtins.
declare module "bun:ffi" {
  type Pointer = number;
  type FFIType = unknown;
}
