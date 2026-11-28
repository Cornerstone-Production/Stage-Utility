import { toast } from "../components/ui";
import { copyText } from "./clipboard";

/** Copy a service or baptism report and say whether it landed. */
export async function copyReport(text: string): Promise<boolean> {
  const ok = await copyText(text);
  if (ok) toast.success("Report copied to clipboard");
  else toast.error("Couldn't copy the report");
  return ok;
}
