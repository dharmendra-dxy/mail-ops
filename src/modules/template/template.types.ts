import { CandidateRole } from '../google-sheet';
import { ROLE_LABELS, TEMPLATE_TYPES } from './template.constant';

export type TemplateType = (typeof TEMPLATE_TYPES)[keyof typeof TEMPLATE_TYPES];

export type RoleLabel = (typeof ROLE_LABELS)[CandidateRole];

/** Raw, un-rendered template text. */
export interface MailTemplate {
  subject: string;
  body: string;
}

export interface TemplateContext {
  name: string;
  firstName: string;
  company: string;
  role: CandidateRole;
  roleLabel: RoleLabel;
}

export interface RenderedEmail {
  subject: string;
  body: string;
}
