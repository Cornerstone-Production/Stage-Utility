// ip-list-field.tsx — a growable list of IP addresses for an `ip-list` config field.
//
// One copy. It lived verbatim in both integrations-panel.tsx and
// wireless-connections-panel.tsx, which is how a fix to one of them would have
// missed the other.

import type { ChangeEvent } from "react";
import { Button, Input } from "./ui";
import { PlusIcon, TrashIcon } from "lucide-react";

interface IpListFieldProps {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}

export function IpListField({ value, onChange, placeholder }: IpListFieldProps) {
  function update(idx: number, v: string) {
    const next = [...value];
    next[idx] = v;
    onChange(next);
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...value, ""]);
  }

  return (
    <div className="flex flex-col gap-1 w-full">
      {value.map((ip, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <Input
            value={ip}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update(idx, e.target.value)}
            placeholder={placeholder ?? "192.168.1.x"}
            className="flex-1 min-w-0"
          />
          <Button
            variant="transparent"
            size="small"
            iconOnly
            onClick={() => remove(idx)}
            aria-label="Remove"
          >
            <TrashIcon className="size-3.5 text-gray-9" />
          </Button>
        </div>
      ))}
      <Button variant="transparent" size="small" onClick={add} className="self-start">
        <PlusIcon className="size-3.5 text-gray-9" />
        Add IP
      </Button>
    </div>
  );
}
