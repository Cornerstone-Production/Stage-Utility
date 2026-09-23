// action-button-inspector.tsx — the action-button object's config editor:
// pick the action, edit its parameters, set the label.
//
// Its own component, like action-picker.tsx and cue-picker.tsx, so the
// registry read and the write-back into config can be rendered in a test
// without mounting the whole Inspector and every other object type's hooks.
//
// The action select and the per-parameter fields are the SAME components the
// automation rule editor uses (ActionPicker's list, ParamField, the
// companion.press coordinate picker) — one registry, one set of field
// widgets, so a param this repo already knows how to edit does not grow a
// second, differently-behaved copy here.

import { useQuery } from "@tanstack/react-query";

import { invoke } from "../lib/api";
import { ActionPicker } from "./action-picker";
import { Row, RowText } from "./inspector-rows";
import type { LayoutObjectConfig } from "@main/types/views";
import { ParamField, type Registry } from "../settings/sections/rule-editor-dialog";
import { useOptionSources } from "../settings/sections/automation-option-sources";
import { CompanionPressFields } from "../settings/sections/companion-cues";

export function ActionButtonInspector({
  c,
  onConfig,
}: {
  c: Extract<LayoutObjectConfig, { type: "action-button" }>;
  onConfig: (c: LayoutObjectConfig) => void;
}) {
  // The SAME registry the rule editor reads (GET /api/automation/registry) —
  // same query key, so react-query shares one answer if both are ever open at
  // once. Unconditional here (not gated on c.type, unlike the query this
  // mirrors in the rule editor): this component only ever mounts for an
  // action-button object in the first place.
  const { data: registry } = useQuery({
    queryKey: ["automation:registry"],
    queryFn: () => invoke<Registry>("automation:registry"),
  });
  const optionSources = useOptionSources();
  const actions = registry?.actions ?? null;
  const action = actions?.find((a) => a.id === c.actionId) ?? null;
  const params = c.params ?? {};

  return (
    <>
      <Row
        label="Action"
        hint="Any action the automation rules editor can run — the same registry, the same parameters. A saved id the registry no longer has still shows, marked, so the button stays editable."
      >
        <ActionPicker
          actions={actions}
          value={c.actionId}
          onChange={(id) => onConfig({ ...c, actionId: id, params: {} })}
        />
      </Row>
      {action?.help && <p className="text-caption2 text-fg-muted leading-snug">{action.help}</p>}
      {c.actionId === "companion.press" ? (
        <CompanionPressFields
          params={params as Record<string, string | number>}
          onChange={(patch) => onConfig({ ...c, params: { ...params, ...patch } })}
        />
      ) : (
        action?.params.map((p) => (
          <ParamField
            key={p.key}
            spec={p}
            value={params[p.key] as string | number | undefined}
            optionSources={optionSources}
            onChange={(v) => onConfig({ ...c, params: { ...params, [p.key]: v } })}
          />
        ))
      )}
      <RowText
        label="Label"
        hint="Blank uses the action's own label."
        value={c.label ?? ""}
        placeholder={action?.label ?? "Action"}
        onChange={(v) => onConfig({ ...c, label: v })}
      />
    </>
  );
}
