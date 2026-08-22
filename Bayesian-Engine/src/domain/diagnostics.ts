export type DiagnosticSeverity = "error" | "warning";

export type DiagnosticCategory =
  | "xml"
  | "structure"
  | "reference"
  | "probability"
  | "value"
  | "compatibility";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  message: string;
  networkIndex?: number;
  variableName?: string;
  definitionFor?: string;
  parentConfigurationIndex?: number;
  tableIndex?: number;
  path?: string;
  line?: number;
  column?: number;
}
