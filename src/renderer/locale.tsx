// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Localization context: components call t("English source") exactly like the
// upstream Chrome.localized flow; zh-Hans comes from the frozen catalog.

import { createContext, useContext } from "react";
import type { LanguageId } from "../shared/types";
import { translate } from "./i18n";

export const LanguageContext = createContext<LanguageId>("en");

export function useT(): (key: string, ...vars: string[]) => string {
  const lang = useContext(LanguageContext);
  return (key, ...vars) => translate(lang, key, vars);
}
