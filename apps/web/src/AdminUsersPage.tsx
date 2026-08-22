import { type FormEvent, useEffect, useState } from "react";

import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  TextInput,
} from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type ManagedUser =
  operations["listUsers"]["responses"][200]["content"]["application/json"]["users"][number];
type UserAction = { kind: "rename" | "password" | "reset"; user: ManagedUser };

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return "Request failed. Try again.";
}

export function AdminUsersPage({ csrfToken }: { csrfToken: string }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<UserAction | null>(null);

  async function loadUsers() {
    setLoading(true);
    const result = await apiClient.GET("/api/v1/admin/users");
    if (result.data) {
      setUsers(result.data.users);
      setError("");
    } else {
      setError(errorMessage(result.error));
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setNotice("");
    const data = new FormData(form);
    const result = await apiClient.POST("/api/v1/admin/users", {
      headers: { "x-csrf-token": csrfToken },
      body: {
        username: String(data.get("username") ?? ""),
        password: String(data.get("password") ?? ""),
        role: data.get("role") === "ADMINISTRATOR" ? "ADMINISTRATOR" : "PSYCHIATRIST",
      },
    });
    if (result.data) {
      form.reset();
      setNotice(`Created ${result.data.user.username}.`);
      await loadUsers();
    } else {
      setError(errorMessage(result.error));
    }
    setBusy(false);
  }

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    setBusy(true);
    setNotice("");
    const value = String(new FormData(event.currentTarget).get("value") ?? "");
    const params = { path: { userId: action.user.id } };
    const common = { params, headers: { "x-csrf-token": csrfToken } };
    const result =
      action.kind === "rename"
        ? await apiClient.PATCH("/api/v1/admin/users/{userId}/username", {
            ...common,
            body: { username: value },
          })
        : action.kind === "password"
          ? await apiClient.PUT("/api/v1/admin/users/{userId}/password", {
              ...common,
              body: { password: value },
            })
          : await apiClient.POST("/api/v1/admin/users/{userId}/reset-password", {
              ...common,
              body: { password: value },
            });
    if (result.data) {
      setNotice(
        action.kind === "reset"
          ? `Temporary password set for ${result.data.user.username}.`
          : `Updated ${result.data.user.username}.`,
      );
      setAction(null);
      await loadUsers();
    } else {
      setError(errorMessage(result.error));
    }
    setBusy(false);
  }

  async function run(user: ManagedUser, kind: "enable" | "disable" | "revoke") {
    setBusy(true);
    setNotice("");
    const params = { path: { userId: user.id } };
    const options = { params, headers: { "x-csrf-token": csrfToken } };
    const result =
      kind === "enable"
        ? await apiClient.POST("/api/v1/admin/users/{userId}/enable", options)
        : kind === "disable"
          ? await apiClient.POST("/api/v1/admin/users/{userId}/disable", options)
          : await apiClient.POST("/api/v1/admin/users/{userId}/revoke-sessions", options);
    if (result.error) {
      setError(errorMessage(result.error));
    } else {
      setNotice(
        kind === "revoke" ? `Revoked sessions for ${user.username}.` : `${user.username} ${kind}d.`,
      );
      await loadUsers();
    }
    setBusy(false);
  }

  if (loading) return <LoadingState label="Loading users" />;
  if (error && users.length === 0)
    return (
      <ErrorState
        title="Users unavailable"
        description={error}
        action={<Button onClick={() => void loadUsers()}>Retry</Button>}
      />
    );

  const rows = users.map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role === "ADMINISTRATOR" ? "Administrator" : "Psychiatrist",
    status: user.status.replaceAll("_", " "),
    actions: (
      <div className="row-actions">
        <Button variant="secondary" onClick={() => setAction({ kind: "rename", user })}>
          Rename
        </Button>
        <Button
          variant="secondary"
          onClick={() => void run(user, user.status === "DISABLED" ? "enable" : "disable")}
          disabled={busy}
        >
          {user.status === "DISABLED" ? "Enable" : "Disable"}
        </Button>
        <Button variant="secondary" onClick={() => setAction({ kind: "password", user })}>
          Change password
        </Button>
        <Button variant="secondary" onClick={() => setAction({ kind: "reset", user })}>
          Temporary reset
        </Button>
        <Button variant="danger" onClick={() => void run(user, "revoke")} disabled={busy}>
          Revoke sessions
        </Button>
      </div>
    ),
  }));

  return (
    <div className="page-stack">
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="card" aria-labelledby="create-user-title">
        <h2 id="create-user-title">Create user</h2>
        <form className="management-form" onSubmit={create}>
          <FormField label="Username" required>
            {(props) => <TextInput {...props} name="username" required maxLength={128} />}
          </FormField>
          <FormField label="Initial password" hint="Use at least 12 characters." required>
            {(props) => (
              <TextInput
                {...props}
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={1024}
                autoComplete="new-password"
              />
            )}
          </FormField>
          <label className="select-field">
            Role
            <select name="role" defaultValue="PSYCHIATRIST">
              <option value="PSYCHIATRIST">Psychiatrist</option>
              <option value="ADMINISTRATOR">Administrator</option>
            </select>
          </label>
          <Button type="submit" loading={busy}>
            Create user
          </Button>
        </form>
      </section>
      {rows.length ? (
        <section className="card" aria-labelledby="users-title">
          <h2 id="users-title">Users</h2>
          <DataTable
            ariaLabel="User accounts"
            caption="Administrator-managed INSIGHT accounts"
            columns={[
              { key: "username", header: "Username" },
              { key: "role", header: "Role" },
              { key: "status", header: "Status" },
              { key: "actions", header: "Actions" },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </section>
      ) : (
        <EmptyState title="No users" description="Create the first managed user." />
      )}
      {action ? (
        <section className="card action-panel" aria-labelledby="user-action-title">
          <h2 id="user-action-title">
            {action.kind === "rename"
              ? "Rename"
              : action.kind === "reset"
                ? "Set temporary password"
                : "Change password"}
            : {action.user.username}
          </h2>
          <form className="inline-form" onSubmit={submitAction}>
            <FormField
              label={
                action.kind === "rename"
                  ? "New username"
                  : action.kind === "reset"
                    ? "Temporary password"
                    : "New password"
              }
              required
            >
              {(props) => (
                <TextInput
                  {...props}
                  name="value"
                  type={action.kind === "rename" ? "text" : "password"}
                  defaultValue={action.kind === "rename" ? action.user.username : ""}
                  minLength={action.kind === "rename" ? 1 : 12}
                  maxLength={action.kind === "rename" ? 128 : 1024}
                  required
                  autoComplete={action.kind === "rename" ? undefined : "new-password"}
                />
              )}
            </FormField>
            <Button type="submit" loading={busy}>
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={() => setAction(null)}>
              Cancel
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
