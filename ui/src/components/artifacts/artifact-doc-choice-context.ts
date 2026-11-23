import { createContext } from "react";
import type { DocChoiceDefinition } from "./artifact-doc-choices";

export const DocChoiceEditContext = createContext<((definition: DocChoiceDefinition) => void) | null>(null);
