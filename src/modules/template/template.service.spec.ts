import { BadRequestException } from '@nestjs/common';
import { Candidate } from '../google-sheet';
import { TemplateService } from './template.service';
import { MAIL_TEMPLATES } from './templates/mail-templates';
import { TEMPLATE_TYPES, TEMPLATE_VARIABLES } from './template.constant';

function buildCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return Object.assign(new Candidate(), {
    rowNumber: 2,
    name: 'Asha Rao',
    email: 'asha@example.com',
    company: 'Acme',
    role: 'FRONTEND',
    status: 'PENDING',
    attempts: 0,
    followUpEnabled: 'NO',
    followUpDays: 0,
    followUpStatus: 'NOT_SCHEDULED',
    ...overrides,
  });
}

describe('TemplateService', () => {
  let service: TemplateService;

  beforeEach(() => {
    service = new TemplateService();
  });

  describe('getTemplate', () => {
    it('has an initial and a follow_up template for every role', () => {
      for (const role of service.getSupportedRoles()) {
        for (const type of service.getSupportedTypes()) {
          const template = service.getTemplate(role, type);

          expect(template).toBeDefined();
          expect(template.subject.length).toBeGreaterThan(0);
          expect(template.body.length).toBeGreaterThan(0);
        }
      }
    });

    it('gives each role distinct copy', () => {
      const subjects = service
        .getSupportedRoles()
        .map(
          (role) => service.getTemplate(role, TEMPLATE_TYPES.INITIAL).subject,
        );

      expect(new Set(subjects).size).toBe(subjects.length);
    });

    it('returns undefined for an unknown role', () => {
      expect(
        service.getTemplate('DESIGNER' as never, TEMPLATE_TYPES.INITIAL),
      ).toBeUndefined();
    });
  });

  describe('buildContext', () => {
    it('derives firstName and a readable role label', () => {
      const context = service.buildContext(buildCandidate());

      expect(context).toEqual({
        name: 'Asha Rao',
        firstName: 'Asha',
        company: 'Acme',
        role: 'FRONTEND',
        roleLabel: 'Frontend',
      });
    });

    it('handles a single-word name', () => {
      expect(
        service.buildContext(buildCandidate({ name: 'Prince' })).firstName,
      ).toBe('Prince');
    });
  });

  describe('render', () => {
    it('interpolates every placeholder', () => {
      const candidate = buildCandidate();
      const rendered = service.render(
        'FRONTEND',
        service.buildContext(candidate),
        TEMPLATE_TYPES.INITIAL,
      );

      expect(rendered.subject).toBe('Frontend role at Acme — quick question');
      expect(rendered.body).toContain('Hi Asha,');
      expect(rendered.body).toContain('the Frontend opening at Acme');
      expect(rendered.body).not.toMatch(/{{|}}/);
    });

    it('renders the follow_up variant', () => {
      const context = service.buildContext(
        buildCandidate({ company: 'Globex' }),
      );
      const rendered = service.render(
        'FRONTEND',
        context,
        TEMPLATE_TYPES.FOLLOW_UP,
      );

      expect(rendered.subject).toBe('Re: Frontend role at Globex');
      expect(rendered.body).toContain('Circling back');
    });

    it('defaults to the initial variant', () => {
      const context = service.buildContext(buildCandidate());

      expect(service.render('FRONTEND', context)).toEqual(
        service.render('FRONTEND', context, TEMPLATE_TYPES.INITIAL),
      );
    });

    it('rejects an unsupported role instead of emailing an empty template', () => {
      expect(() =>
        service.render('QA' as never, service.buildContext(buildCandidate())),
      ).toThrow(BadRequestException);
    });

    it('produces copy for every role without leaking placeholders', () => {
      for (const role of service.getSupportedRoles()) {
        const rendered = service.render(role, {
          name: 'Asha Rao',
          firstName: 'Asha',
          company: 'Acme',
          role,
          roleLabel: 'Frontend',
        });

        expect(rendered.body).not.toMatch(/{{|}}/);
      }
    });
  });

  describe('isSupportedRole', () => {
    it('accepts sheet role values only', () => {
      expect(service.isSupportedRole('FULL_STACK')).toBe(true);
      expect(service.isSupportedRole('full_stack')).toBe(false);
      expect(service.isSupportedRole('')).toBe(false);
    });
  });

  it('only uses placeholders the context actually provides', () => {
    const used = new Set<string>();

    for (const role of service.getSupportedRoles()) {
      for (const type of service.getSupportedTypes()) {
        const template = MAIL_TEMPLATES[role][type];

        for (const source of [template.subject, template.body]) {
          for (const match of source.matchAll(/{{\s*(\w+)\s*}}/g)) {
            used.add(match[1]);
          }
        }
      }
    }

    // Guards against a typo like {{compnay}} silently rendering as empty text.
    for (const variable of used) {
      expect(TEMPLATE_VARIABLES).toContain(variable);
    }
  });
});
