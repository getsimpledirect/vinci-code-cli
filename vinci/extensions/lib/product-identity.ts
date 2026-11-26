/** Source and packaged extensions read the same Vinci product identity. */
import { getVinciVersion } from "./product-version.ts";

export { VINCI_ROOT } from "./product-version.ts";
export const VINCI_VERSION = getVinciVersion();
