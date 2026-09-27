// action-picker.tsx — the Action select on an action-button object.
//
// A flat, labelled list — the same list, in the same order, with the same
// labels, the automation rule editor's own Action select shows
// (rule-editor-dialog.tsx). AUTOMATION_ACTIONS carries no category field to
// group by, and inventing one here would be a second, unshared answer to
// "what this action is called" the rule editor does not have.
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
