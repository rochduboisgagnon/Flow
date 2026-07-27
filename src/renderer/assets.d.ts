// Ambient (no imports: a module file would turn this into an augmentation,
// which TypeScript refuses for wildcard patterns). Vite emits imported images
// as relative hashed asset URLs (base "./"), so the packaged file:// load
// works. Only the titlebar icon uses this; the file is a byte-identical copy
// of resources/icon.png, enforced by scripts/check-icon.cjs at build.
declare module "*.png" {
  const url: string;
  export default url;
}
