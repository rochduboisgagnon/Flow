import { app } from "electron";
import path from "node:path";

/** Dev/packaged path of a bundled resource (extraResources copies resources/*
 * next to the app verbatim). One resolver (audit): this exact three-liner was
 * pasted in four files, each a chance to drift. */
export function resourcePath(rel: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, rel)
    : path.join(app.getAppPath(), "resources", rel);
}
