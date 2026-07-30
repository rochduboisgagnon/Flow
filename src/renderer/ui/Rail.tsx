import React from "react";
import { Icon, IC } from "./components";

// The rail is the product's promise (plan §2.1): every section is visible,
// including the ones whose engine work is a later wave - those pages say so
// honestly instead of hiding. Three families: DO, LIBRARY, and one Settings.
export type Section =
  | "home" | "record" | "import" | "notes" | "stats" | "diagnostics"
  | "dictionary" | "settings";

const TOP: Array<[Section, string, { d: string; d2?: string }]> = [
  ["home", "Home", { d: IC.home }],
  ["record", "Record", { d: IC.record, d2: IC.record2 }],
  ["import", "Import", { d: IC.import }],
  ["notes", "Notes", { d: IC.notes }],
  ["stats", "Statistics", { d: IC.stats }],
  ["diagnostics", "Diagnostics", { d: IC.diag }],
];
const LIBRARY: Array<[Section, string, { d: string; d2?: string }]> = [
  ["dictionary", "Dictionary", { d: IC.dict }],
];

export function Rail({ section, go }: { section: Section; go: (s: Section) => void }) {
  const nav = ([id, label, icon]: [Section, string, { d: string; d2?: string }]) => (
    <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => go(id)}>
      <Icon d={icon.d} d2={icon.d2} />
      {label}
    </button>
  );
  return (
    <nav className="rail" aria-label="Sections">
      {TOP.map(nav)}
      <div className="grp">Library</div>
      {LIBRARY.map(nav)}
      <div className="spacer" />
      {nav(["settings", "Settings", { d: IC.gear, d2: IC.gear2 }])}
    </nav>
  );
}
