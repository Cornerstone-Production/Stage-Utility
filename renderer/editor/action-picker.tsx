// action-picker.tsx — the Action select on an action-button object.
//
// A flat, labelled list: every action in the registry's order, with the labels
// the automation rule editor's grouped picker shows (automation-picker.tsx). It is
// a plain Select because it sits in the layout editor's narrow side panel, where
// the rule editor's two-column picker does not fit.
//
// Its own component, like cue-picker.tsx, so it can be rendered in a test
// without mounting the whole inspector.

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui";

export interface ActionPickerSpec {
  id: string;
  label: string;
}

export function ActionPicker({
  actions,
  value,
  onChange,
}: {
  /** Null while the registry has not answered yet. */
  actions: ActionPickerSpec[] | null;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={actions ? "Pick an action…" : "Loading actions…"} />
      </SelectTrigger>
      <SelectContent>
        {(actions ?? []).map((a) => (
          <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
