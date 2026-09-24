// action-button-inspector.tsx — the action-button object's config editor:
// pick the action, edit its parameters, set the label.
//
// Its own component, like action-picker.tsx and cue-picker.tsx, so the
// registry read and the write-back into config can be rendered in a test
// without mounting the whole Inspector and every other object type's hooks.
//
// The action select and the per-parameter fields are the SAME components the
// automation rule editor uses (ActionPicker, ActionParamsFields) — one
// registry, one set of field widgets, so a param this repo already knows how
// to edit does not grow a second, differently-behaved copy here.

import { useQuery } from "@tanstack/react-query";

import { invoke } from "../lib/api";
import { ActionPicker } from "./action-picker";
import { Row, RowText } from "./inspector-rows";
import type { LayoutObjectConfig } from "@main/types/views";
import { ActionParamsFields, type Registry } from "../settings/sections/rule-editor-dialog";
import { useOptionSources } from "../settings/sections/automation-option-sources";
import { seedNumberDefaults } from "@main/services/automation-param-validation";

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
          onChange={(id) =>
            onConfig({ ...c, actionId: id, params: seedNumberDefaults(actions?.find((a) => a.id === id)?.params ?? []) })
          }
        />
      </Row>
      {action?.help && <p className="text-caption2 text-fg-muted leading-snug">{action.help}</p>}
      <ActionParamsFields
        actionId={c.actionId}
        action={action}
        params={params as Record<string, string | number>}
        optionSources={optionSources}
        onChange={(next) => onConfig({ ...c, params: next })}
      />
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
