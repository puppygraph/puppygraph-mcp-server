import { CATALOG_FORM } from "./catalog-spec.data.js";

/**
 * The PuppyGraph catalog form, as PuppyGraph AI's get_catalog_connection_spec
 * serves it: which fields each catalog type takes, with their exact names.
 * PuppyGraph has no HTTP route for it, so a copy is bundled (regenerate with
 * scripts/update-catalog-spec.mjs).
 */

export interface CatalogFormField {
  name: string;
  type?: string;
  label?: string;
  defaultValue?: unknown;
  required?: boolean;
  requiredIf?: unknown;
  opts?: Array<{ value: unknown; label?: string }>;
  sensitive?: boolean;
  tooltip?: string;
  placeholder?: string;
}

export interface CatalogFormDependency {
  name: string;
  value: string | boolean;
  displayFields: string[];
  docUrl?: string;
}

export interface CatalogForm {
  alwaysActiveFields: string[];
  jdbcCommonFields: string[];
  fieldDeps: CatalogFormDependency[];
  allFields: CatalogFormField[];
}

const FIELDS = new Map(CATALOG_FORM.allFields.map((field) => [field.name, field]));

/** Fields create_catalog fills from its own parameters, not from options. */
export const PARAMETER_FIELDS: Record<string, string> = {
  catalogName: "name",
  catalogType: "type",
  jdbcUri: "jdbc_uri",
  jdbcUsername: "username",
  jdbcPassword: "password / password_env",
  driverClass: "driver_class",
  driverUrl: "driver_url",
};

/** A field required only when another field has one of some values. */
function requiredIf(field: CatalogFormField): { name: string; values: unknown[] } | undefined {
  const rule = field.requiredIf as { name?: unknown; values?: unknown } | undefined;
  return rule && typeof rule.name === "string" && Array.isArray(rule.values)
    ? { name: rule.name, values: rule.values }
    : undefined;
}

export function catalogTypes(): Array<{ type: string; label: string; doc_url?: string }> {
  const typeField = FIELDS.get("catalogType");
  return (typeField?.opts ?? []).map((option) => {
    const type = String(option.value);
    const doc = CATALOG_FORM.fieldDeps.find((dep) => dep.name === "catalogType" && dep.value === type)?.docUrl;
    return { type, label: option.label ?? type, ...(doc ? { doc_url: doc } : {}) };
  });
}

export function isKnownCatalogType(type: string): boolean {
  return catalogTypes().some((entry) => entry.type === type);
}

export function isSensitiveCatalogField(name: string): boolean {
  return FIELDS.get(name)?.sensitive === true;
}

/** The names of every sensitive field in the form, for masking. */
export function sensitiveCatalogFields(): string[] {
  return CATALOG_FORM.allFields.filter((field) => field.sensitive).map((field) => field.name);
}

function describeField(field: CatalogFormField) {
  return {
    name: field.name,
    ...(field.label ? { label: field.label } : {}),
    ...(field.type ? { type: field.type } : {}),
    ...(field.required ? { required: true } : {}),
    ...(requiredIf(field) ? { required_when: { [requiredIf(field)!.name]: requiredIf(field)!.values } } : {}),
    ...(field.defaultValue !== undefined && field.defaultValue !== "" ? { default: field.defaultValue } : {}),
    ...(field.opts ? { options: field.opts.map((option) => option.value) } : {}),
    ...(field.sensitive ? { sensitive: true } : {}),
    ...(field.tooltip ? { tooltip: field.tooltip } : {}),
    ...(field.placeholder ? { example: field.placeholder } : {}),
    ...(PARAMETER_FIELDS[field.name] ? { pass_as: PARAMETER_FIELDS[field.name] } : {}),
  };
}

/**
 * Every field a catalog type can show, whatever is chosen in its selects,
 * and the rules that decide which ones apply (as catalogform.Spec does).
 */
export function catalogSpec(type: string) {
  const reachable = new Set(["catalogType", "catalogName"]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const dep of CATALOG_FORM.fieldDeps) {
      if (!reachable.has(dep.name) || (dep.name === "catalogType" && dep.value !== type)) continue;
      for (const name of dep.displayFields) {
        if (!reachable.has(name)) {
          reachable.add(name);
          changed = true;
        }
      }
    }
  }
  const doc = CATALOG_FORM.fieldDeps.find((dep) => dep.name === "catalogType" && dep.value === type)?.docUrl;
  return {
    type,
    ...(doc ? { doc_url: doc } : {}),
    fields: CATALOG_FORM.allFields
      .filter((field) => reachable.has(field.name) && field.name !== "catalogType" && field.name !== "catalogName")
      .map(describeField),
    shown_when: CATALOG_FORM.fieldDeps
      .filter((dep) => reachable.has(dep.name) && dep.name !== "catalogType")
      .map((dep) => ({ when: { [dep.name]: dep.value }, fields: dep.displayFields })),
  };
}

/**
 * The fields that apply to the given values, and which required ones are
 * missing. Only the selects and checkboxes that were actually set decide
 * which fields apply: PuppyGraph treats an absent select as its plain case
 * (e.g. no snowflakeAuthType means a JDBC URI), not as the form's default, so
 * a required field with a default is not reported missing either. Field
 * names the form doesn't know are reported separately: the server reads a
 * few fields the form doesn't list, so they are not errors.
 */
export function checkCatalogValues(type: string, values: Record<string, unknown>) {
  const effective = (name: string): unknown => values[name];
  const active = new Set(["catalogType", "catalogName"]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const dep of CATALOG_FORM.fieldDeps) {
      if (!active.has(dep.name)) continue;
      const current = dep.name === "catalogType" ? type : effective(dep.name);
      const matches = typeof dep.value === "boolean"
        ? (current === true || current === "true") === dep.value
        : current === dep.value;
      if (!matches) continue;
      for (const name of dep.displayFields) {
        if (!active.has(name)) {
          active.add(name);
          changed = true;
        }
      }
    }
  }
  const missing = [...active].filter((name) => {
    const field = FIELDS.get(name);
    if (!field || name === "catalogType" || name === "catalogName") return false;
    const conditional = requiredIf(field);
    const required = field.required === true ||
      (conditional !== undefined && conditional.values.includes(effective(conditional.name)));
    if (!required) return false;
    const value = effective(name);
    if (value === "" || value === null) return true;
    // An absent field with a default is the server's plain case.
    const fallback = field.defaultValue;
    return value === undefined && (fallback === undefined || fallback === "");
  });
  const unknown = Object.keys(values).filter((name) => !FIELDS.has(name));
  const options: Record<string, unknown[]> = {};
  for (const name of [...active, ...Object.keys(values)]) {
    const field = FIELDS.get(name);
    const value = values[name];
    if (field?.type === "select" && field.opts && value !== undefined && value !== "" &&
      !field.opts.some((option) => option.value === value)) {
      options[name] = field.opts.map((option) => option.value);
    }
  }
  return { missing, unknown, invalid_options: options };
}
