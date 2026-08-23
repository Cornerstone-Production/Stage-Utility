// select-field.tsx — a labelled select, from the shared Select primitive.
//
// The primitive is a compound API (Select / SelectTrigger / SelectValue /
// SelectContent / SelectItem), which is right for the cases that need a custom
// trigger. Signage has a dozen plain "label plus a list of options" fields, and
// spelling the compound form out a dozen times is where a missing aria-label or
// an inconsistent width creeps in.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder,
  className,
  hideLabel = false,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Drop the visible caption, keeping it as the trigger's aria-label.
   *
   *  For a select that sits in a row beside buttons: the caption made the field
   *  taller than its neighbours, so the control and the button next to it did
   *  not line up however the row was aligned. */
  hideLabel?: boolean;
}) {
  const field = (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // No <label> wrapper when the caption is hidden: a label with nothing visible
  // in it is a click target that looks like empty space.
  if (hideLabel) return field;

  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption1 text-fg-muted">{label}</span>
      {field}
    </label>
  );
}
