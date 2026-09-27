/**
 * Template variants. Phase 2 renders `initial`; Phase 4 sends `follow_up`.
 * Keys match the `role` values in the sheet so no mapping layer is needed.
 */
export const TEMPLATE_TYPES = {
  INITIAL: 'initial',
  FOLLOW_UP: 'follow_up',
} as const;

/** Handlebars variables available to every template. */
export const TEMPLATE_VARIABLES = [
  'name',
  'firstName',
  'company',
  'role',
  'roleLabel',
] as const;

/** Human-readable role names used inside the email copy. */
export const ROLE_LABELS = {
  FRONTEND: 'Frontend',
  BACKEND: 'Backend',
  FULL_STACK: 'Full Stack',
} as const;

export const DEFAULT_TEMPLATE_TYPE = TEMPLATE_TYPES.INITIAL;
