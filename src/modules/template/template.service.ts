import { BadRequestException, Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import { CANDIDATE_ROLES, CandidateRole, Candidate } from '../google-sheet';
import {
  DEFAULT_TEMPLATE_TYPE,
  ROLE_LABELS,
  TEMPLATE_TYPES,
} from './template.constant';
import { MAIL_TEMPLATES } from './templates/mail-templates';
import {
  MailTemplate,
  RenderedEmail,
  TemplateContext,
  TemplateType,
} from './template.types';

@Injectable()
export class TemplateService {
  /** Compiling on every send is wasteful; templates never change at runtime. */
  private readonly compiled = new Map<string, HandlebarsTemplateDelegate>();

  getTemplate(
    role: CandidateRole,
    type: TemplateType = DEFAULT_TEMPLATE_TYPE,
  ): MailTemplate {
    return MAIL_TEMPLATES[role]?.[type];
  }

  render(
    role: CandidateRole,
    context: TemplateContext,
    type: TemplateType = DEFAULT_TEMPLATE_TYPE,
  ): RenderedEmail {
    const template = this.getTemplate(role, type);

    if (!template) {
      throw new BadRequestException(
        `No "${type}" template for role "${role}". Available: ${CANDIDATE_ROLES.join(', ')}`,
      );
    }

    return {
      subject: this.renderString(template.subject, context),
      body: this.renderString(template.body, context),
    };
  }

  /** Builds the template variables for a sheet row. */
  buildContext(candidate: Candidate): TemplateContext {
    const role = candidate.role as CandidateRole;

    return {
      name: candidate.name,
      firstName: candidate.name.split(/\s+/)[0] ?? candidate.name,
      company: candidate.company,
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
    };
  }

  isSupportedRole(role: string): role is CandidateRole {
    return (CANDIDATE_ROLES as readonly string[]).includes(role);
  }

  getSupportedRoles(): readonly CandidateRole[] {
    return CANDIDATE_ROLES;
  }

  getSupportedTypes(): readonly TemplateType[] {
    return Object.values(TEMPLATE_TYPES);
  }

  private renderString(source: string, context: TemplateContext): string {
    return this.compile(source)(context);
  }

  private compile(source: string): HandlebarsTemplateDelegate {
    const cached = this.compiled.get(source);
    if (cached) return cached;

    const compiled = Handlebars.compile(source, { strict: false });
    this.compiled.set(source, compiled);

    return compiled;
  }
}
