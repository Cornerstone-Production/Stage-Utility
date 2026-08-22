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
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption1 text-fg-muted">{label}</span>
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
    </label>
  );
}
