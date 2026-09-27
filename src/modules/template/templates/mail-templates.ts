import { CandidateRole } from '../../google-sheet';
import { TEMPLATE_TYPES } from '../template.constant';
import { MailTemplate, TemplateType } from '../template.types';

/**
 * Email copy lives in code, not in the sheet, so a campaign always renders the
 * same wording. Handlebars placeholders: {{name}} {{firstName}} {{company}}
 * {{role}} {{roleLabel}}.
 */
export const MAIL_TEMPLATES: Record<
  CandidateRole,
  Record<TemplateType, MailTemplate>
> = {
  FRONTEND: {
    [TEMPLATE_TYPES.INITIAL]: {
      subject: 'Frontend role at {{company}} — quick question',
      body: `Hi {{firstName}},

I came across the {{roleLabel}} opening at {{company}} and wanted to reach out directly.

I'm a frontend engineer who works mostly in TypeScript and React, with a bias toward interfaces that stay fast and accessible as the product grows — design systems, data-heavy views, and the unglamorous work of making state management boring.

I'd love to hear what the team is prioritising on the frontend right now, and where you see the most room to contribute. Happy to send over a short write-up of relevant work, or work through a specific problem you have in mind, whichever is more useful.

If a short conversation makes sense, I'm easy to reach and happy to work around your schedule. And if this isn't relevant at all, just reply and I'll stop following up.

Best regards`,
    },
    [TEMPLATE_TYPES.FOLLOW_UP]: {
      subject: 'Re: Frontend role at {{company}}',
      body: `Hi {{firstName}},

Circling back on my note about the {{roleLabel}} role at {{company}} — I know inboxes are noisy, so this is the only follow-up I'll send.

If the role is still open, the quickest way to help me be useful is to point me at one thing the team is trying to solve. I'll come back with something concrete rather than a generic introduction.

If the timing isn't right, no problem at all — I'll close this out.

Best regards`,
    },
  },
  BACKEND: {
    [TEMPLATE_TYPES.INITIAL]: {
      subject: 'Backend role at {{company}} — quick question',
      body: `Hi {{firstName}},

I saw the {{roleLabel}} opening at {{company}} and wanted to get in touch.

I'm a backend engineer focused on services that stay predictable under load — API design, data modelling, and the observability work that tells you what a system is actually doing. Most of my recent work has been in Node.js and Python against Postgres, with a lot of time spent on migrations, idempotency, and making retries safe.

I'd be glad to hear how the team is thinking about {{company}}'s backend right now, and where a new engineer could add the most value in the first few months.

If a short conversation is useful, I'm happy to work around your schedule — and if this isn't relevant, a quick reply and I'll leave it there.

Best regards`,
    },
    [TEMPLATE_TYPES.FOLLOW_UP]: {
      subject: 'Re: Backend role at {{company}}',
      body: `Hi {{firstName}},

Following up once on my note about the {{roleLabel}} role at {{company}}.

If the position is still open, send me a problem you're currently wrestling with — a slow query, a flaky deploy, a service boundary that's grown awkward — and I'll write up how I'd approach it. That's more useful for you than another introduction email.

If the timing is off, that's completely fine.

Best regards`,
    },
  },
  FULL_STACK: {
    [TEMPLATE_TYPES.INITIAL]: {
      subject: 'Full stack role at {{company}} — quick question',
      body: `Hi {{firstName}},

Your {{roleLabel}} opening at {{company}} caught my eye, so I wanted to reach out directly.

I work across the whole stack, which usually means owning a feature end to end: shaping the data model, building the API, and getting the interface in front of real users — then keeping it fast and maintainable once the launch dust settles.

I'm most useful on work where the boundaries between frontend and backend are blurry and someone has to hold the whole thing in their head. I'd love to understand what {{company}} is building in the next couple of quarters and where that kind of end-to-end ownership would matter most.

Happy to set up a short call at your convenience. If this isn't relevant, just reply and I'll stop.

Best regards`,
    },
    [TEMPLATE_TYPES.FOLLOW_UP]: {
      subject: 'Re: Full stack role at {{company}}',
      body: `Hi {{firstName}},

One follow-up on my earlier note about the {{roleLabel}} role at {{company}} — I don't want to crowd your inbox.

If the role is still open, I'm happy to mock up my take on one of your actual features end to end, or simply answer questions about how I work across the stack. Either way, you get something concrete to judge.

If now isn't the moment, no hard feelings at all.

Best regards`,
    },
  },
};
