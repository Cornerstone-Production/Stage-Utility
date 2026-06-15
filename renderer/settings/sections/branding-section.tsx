import { useState, useEffect, useRef, type ChangeEvent } from "react";
import { UploadIcon, TrashIcon, CropIcon } from "lucide-react";
import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Button,
  Input,
  Switch,
  toast,
} from "../../components/ui";
import { invoke } from "../../lib/api";
import { BrandLogo } from "../../components/brand-logo";
import type { SectionProps } from "../types";
import { LogoCropper } from "./logo-cropper";

// Keep in sync with the server-side cap in remote-server.ts (~1.5 MB decoded
// leaves headroom under the 2 MB data-URL limit).
const MAX_LOGO_BYTES = 1_500_000;
const ACCEPTED = "image/png,image/jpeg,image/svg+xml,image/webp";

type Crop = { scale: number; x: number; y: number };
type Target = "app" | "empty";

export function BrandingSection({
  stageState,
  handlers,
}: Pick<SectionProps, "stageState" | "handlers">) {
  const [name, setName] = useState(stageState.appName);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropInitial, setCropInitial] = useState<Crop | null>(null);
  const [cropTarget, setCropTarget] = useState<Target>("app");
  const fileRef = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<Target>("app");

  useEffect(() => {
    setName(stageState.appName);
  }, [stageState.appName]);

  function commitName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === stageState.appName) {
      setName(stageState.appName);
      return;
    }
    handlers.handleSetBranding({ name: trimmed });
  }

  function openPicker(target: Target) {
    pickTarget.current = target;
    fileRef.current?.click();
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("Image is too large — please use one under 1.5 MB.");
      return;
    }
    const target = pickTarget.current;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        toast.error("Could not read that image.");
        return;
      }
      setCropTarget(target);
      setCropInitial(null); // fresh upload
      setCropSrc(dataUrl);
    };
    reader.onerror = () => toast.error("Could not read that image.");
    reader.readAsDataURL(file);
  }

  // Re-open the editor on the ORIGINAL upload, restoring saved zoom/position.
  async function onAdjust(target: Target) {
    const fallback = target === "app" ? stageState.appLogo : stageState.emptySlotLogo;
    try {
      const source = await invoke<BrandingSource>("stage:getBrandingSource", { target });
      setCropTarget(target);
      setCropInitial(source.crop ?? null);
      setCropSrc(source.original ?? fallback);
    } catch {
      setCropTarget(target);
      setCropInitial(null);
      setCropSrc(fallback);
    }
  }

  function onCropSave(result: { logo: string; original: string; crop: Crop }) {
    const target = cropTarget;
    setCropSrc(null);
    if (target === "app") {
      handlers.handleSetBranding({
        logo: result.logo,
        logoOriginal: result.original,
        logoCrop: result.crop,
      });
    } else {
      handlers.handleSetBranding({
        emptyLogo: result.logo,
        emptyLogoOriginal: result.original,
        emptyLogoCrop: result.crop,
      });
    }
  }

  return (
    <div className="px-5 flex flex-col gap-6 py-5">
      {/* Shared hidden file input (target chosen by whichever Upload was clicked). */}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED}
        onChange={onPickFile}
        className="hidden"
        aria-hidden="true"
      />

      <FieldSet title="Branding">
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>App name</FieldLabel>
              <FieldDescription>
                Shown in the settings sidebar and on the kiosk display. Set it to your church or
                organization's name.
              </FieldDescription>
            </FieldContent>
            <Input
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder="Mic Utility"
              className="w-60"
              aria-label="App name"
            />
          </Field>

          {/* ── App logo ── */}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Logo</FieldLabel>
              <FieldDescription>
                PNG, JPG, SVG, or WebP, up to 1.5 MB. Appears next to the name.
              </FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-12 rounded-md border border-gray-a4 bg-gray-a2 overflow-hidden shrink-0 text-gray-12">
                {stageState.appLogo ? (
                  <BrandLogo
                    logo={stageState.appLogo}
                    monochrome={stageState.appLogoMonochrome}
                    className="size-full"
                  />
                ) : (
                  <span className="text-caption2 text-gray-9">None</span>
                )}
              </div>
              <Button variant="filled" size="small" onClick={() => openPicker("app")}>
                <UploadIcon className="size-3.5 text-gray-9" />
                {stageState.appLogo ? "Replace" : "Upload"}
              </Button>
              {stageState.appLogo && (
                <>
                  <Button variant="filled" size="small" onClick={() => onAdjust("app")}>
                    <CropIcon className="size-3.5 text-gray-9" />
                    Adjust
                  </Button>
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    onClick={() => handlers.handleSetBranding({ logo: null })}
                    aria-label="Remove logo"
                  >
                    <TrashIcon className="size-3.5 text-red-10" />
                  </Button>
                </>
              )}
            </div>
          </Field>

          {stageState.appLogo && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Recolor to match theme</FieldLabel>
                <FieldDescription>
                  Best for single-color logos — recolors to match light/dark (and the kiosk's
                  gray). Turn off to show a full-color logo exactly as uploaded.
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={stageState.appLogoMonochrome}
                onCheckedChange={(v: boolean) => handlers.handleSetBranding({ monochrome: v })}
                aria-label="Recolor logo to match theme"
              />
            </Field>
          )}

          {/* ── Empty-slot image ── */}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Empty slot image</FieldLabel>
              <FieldDescription>
                Centered in empty slots on the kiosk, recolored to the display's gray. Optional.
              </FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-12 rounded-md border border-gray-a4 overflow-hidden shrink-0 bg-[#13131a] text-white/45">
                {stageState.emptySlotLogo ? (
                  <BrandLogo logo={stageState.emptySlotLogo} monochrome className="size-full p-1" />
                ) : (
                  <span className="text-caption2 text-white/30">None</span>
                )}
              </div>
              <Button variant="filled" size="small" onClick={() => openPicker("empty")}>
                <UploadIcon className="size-3.5 text-gray-9" />
                {stageState.emptySlotLogo ? "Replace" : "Upload"}
              </Button>
              {stageState.emptySlotLogo && (
                <>
                  <Button variant="filled" size="small" onClick={() => onAdjust("empty")}>
                    <CropIcon className="size-3.5 text-gray-9" />
                    Adjust
                  </Button>
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    onClick={() => handlers.handleSetBranding({ emptyLogo: null })}
                    aria-label="Remove empty slot image"
                  >
                    <TrashIcon className="size-3.5 text-red-10" />
                  </Button>
                </>
              )}
            </div>
          </Field>

          {/* Crop / zoom editor — shared by both images. */}
          {cropSrc && (
            <LogoCropper
              src={cropSrc}
              initial={cropInitial}
              onCancel={() => setCropSrc(null)}
              onSave={onCropSave}
            />
          )}
        </FieldGroup>
      </FieldSet>
    </div>
  );
}
