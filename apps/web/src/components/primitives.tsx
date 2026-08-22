import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
};

export function Button({
  children,
  className = "",
  disabled,
  loading = false,
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button--${variant} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {loading ? <span className="sr-only">Loading: </span> : null}
      {children}
    </button>
  );
}

type FieldRenderProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

type FormFieldProps = {
  label: string;
  children: (props: FieldRenderProps) => ReactNode;
  hint?: string;
  error?: string;
  required?: boolean;
};

export function FormField({ children, error, hint, label, required }: FormFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="form-field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {hint ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="text-input" type="text" {...props} />;
}

type Column<Row> = {
  key: string;
  header: string;
  render?: (row: Row) => ReactNode;
};

type DataTableProps<Row extends Record<string, ReactNode>> = {
  ariaLabel: string;
  caption: string;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
};

export function DataTable<Row extends Record<string, ReactNode>>({
  ariaLabel,
  caption,
  columns,
  rows,
  rowKey,
}: DataTableProps<Row>) {
  return (
    <div className="table-region" role="region" aria-label={ariaLabel} tabIndex={0}>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key}>{column.render?.(row) ?? row[column.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Tone = "urgent" | "warning" | "normal" | "follow-up" | "info";

export function Badge({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`badge badge--${tone}`}>
      <span className="badge__marker" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Banner({
  children,
  title,
  tone = "info",
}: {
  children: ReactNode;
  title: string;
  tone?: Exclude<Tone, "normal" | "follow-up">;
}) {
  const titleId = useId();

  return (
    <section
      className={`banner banner--${tone}`}
      role={tone === "urgent" ? "alert" : "status"}
      aria-labelledby={titleId}
    >
      <div>
        <h2 id={titleId}>{title}</h2>
        <div>{children}</div>
      </div>
    </section>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state-card" role="status" aria-live="polite">
      <span className="spinner spinner--large" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  const titleId = useId();

  return (
    <section className="state-card" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

export function ErrorState({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  const titleId = useId();

  return (
    <section className="error-state" role="alert" aria-labelledby={titleId}>
      <div className="error-state__icon" aria-hidden="true">
        !
      </div>
      <div>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        {action}
      </div>
    </section>
  );
}
