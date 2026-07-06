// Pure routing decision: given the focus probe's answer, where does the
// dictated text go? This is the plan's 5.3/5.4 rule, isolated so it is
// unit-tested without any OS calls.
//
// - editable focused field  -> "insert" (type/paste at the cursor)
// - anything else, or doubt -> "clipboard" (leave it for a manual Ctrl+V)
// Nothing is ever stored either way (5.4): "clipboard" is the whole fallback.

export interface FocusResult {
  editable: boolean;
  control: string;
  app: string;
}

export type Route = "insert" | "clipboard";

export function decideRoute(focus: FocusResult | null): Route {
  // A null probe (crashed, timed out, no answer) is doubt -> HOLD to clipboard,
  // never a blind insert.
  if (!focus) return "clipboard";
  return focus.editable ? "insert" : "clipboard";
}

// Tolerant parse of one probe line. Malformed / partial output must degrade to
// "not editable", never throw into the dictation path.
export function parseFocusLine(line: string): FocusResult | null {
  try {
    const o: unknown = JSON.parse(line);
    if (typeof o !== "object" || o === null) return null;
    const r = o as Record<string, unknown>;
    if (typeof r.editable !== "boolean") return null;
    return {
      editable: r.editable,
      control: typeof r.control === "string" ? r.control : "",
      app: typeof r.app === "string" ? r.app : "",
    };
  } catch {
    return null;
  }
}
