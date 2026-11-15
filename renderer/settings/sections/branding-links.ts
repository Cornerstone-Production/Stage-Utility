// Links into Branding from elsewhere in the app.

/** `?logo=replace` on Branding opens its logo dialog: the sidebar's Replace logo…
 *  means Branding's own picker and crop editor, not a second copy of them. */
export const LOGO_REQUEST_PARAM = "logo";
export const LOGO_REQUEST_VALUE = "replace";
export const BRANDING_HREF = "/settings/branding";
export const REPLACE_LOGO_HREF = `/settings/branding?${LOGO_REQUEST_PARAM}=${LOGO_REQUEST_VALUE}`;
